/* eslint-disable no-constant-condition */
/* eslint-disable no-await-in-loop */
import { cacheMap } from "../cache.ts";
import { Embed, Button, ActionRow } from "@lilybird/jsx";
import { ButtonStyle } from "lilybird";
import type { ActionRowStructure, Channel, EmbedStructure, Message } from "lilybird";
import type { CacheMapInterface, Details } from "../types/scoresTypes.ts";
import type { MessageCommand } from "@lilybird/handlers";

// Represents the queue of user IDs waiting for processing.
const queue: Array<Record<string, [Channel, Message]>> = [];

async function processScores(userId: string, channel: Channel, message: Message, newMsg: Message): Promise<void> {
    // Reads the beatmap file
    let data: Details;
    try {
        data = await import(`../../performanceCalculator/scores/${userId}.json`) as Details;
    } catch (e) {
        console.error(e);
        await newMsg.edit("A wrong user Id was given, aborting task.");
        return;
    }

    await newMsg.edit("Proccessing complete, preparing embed.");
    const page = 0;

    // Cache options
    const optionsCache = { page, data, channel, authorId: message.author.id };

    const settings = prepareDiscordMessage(optionsCache);
    if (settings === false) return;

    const sentMessage = await channel.send(settings);

    // Sets a cache using the message's id so it can be accessed later.
    cacheMap.set(sentMessage.id, { page, data, channel, authorId: message.author.id });
}

export function prepareDiscordMessage(cacheData: CacheMapInterface | undefined): false | { content: string, embeds: Array<EmbedStructure>, components: Array<ActionRowStructure> } {
    if (!cacheData) return false;
    const { authorId, page, data } = cacheData;

    const scoresData = data;
    const { Scores: scores } = scoresData;
    if (page < 0 || page > Math.ceil(scores.length / 5)) return false;

    const pageStart = page * 5;
    const pageEnd = pageStart + 5;

    const descriptionArray: Array<string> = [];
    for (let idx = pageStart; idx < pageEnd && idx < scores.length; idx++) {
        const score = scores[idx];

        const ppDifference = (score.LocalPp - score.LivePp).toFixed(2);
        const diff = +ppDifference > 0 ? `+${ppDifference}` : ppDifference;
        const pp = `\`${score.LivePp.toFixed(2)}pp\`-\`${score.LocalPp.toFixed(2)}pp\``;
        const missEmoji = "<:hit00:1061254490075955231>";

        const text = `\`#${idx + 1}\` [**${score.BeatmapName}**](https://osu.ppy.sh/b/${score.BeatmapId}})
        **Live/Local pp:** ${pp} (${diff}) • \`+${score.Mods.join("") || "NM"}\` • \`${score.Combo.toLocaleString()}x\`
        **Accuracy**: \`${score.Accuracy.toFixed(2)}%\` • **Misses:** \`${score.MissCount}\`${missEmoji} • **Position Change:** \`${score.PositionChange}\``;
        descriptionArray.push(text);
    }

    const difference = (scoresData.LocalPp - scoresData.LivePp).toFixed(2);

    const buttons = ActionRow({ children: [Button({ id: "previous", style: ButtonStyle.Primary, label: "<-" }), Button({ id: "next", style: ButtonStyle.Primary, label: "->" })] });
    const embed = Embed({
        title: `${scoresData.Username}'s Rework Statistics`,
        description: `**Live pp:** \`${scoresData.LivePp.toFixed(2)}pp\`
        **Local pp:** \`${scoresData.LocalPp.toFixed(2)}pp\` (${+difference > 0 ? `+${difference}` : difference}pp difference)
        **Playcount pp:** \`${scoresData.PlaycountPp.toFixed(2)}pp\`\n\n__**Scores:**__\n${descriptionArray.join("\n")}`
    });

    return { content: `<@${authorId}>`, embeds: [embed], components: [buttons] };
}

// Processes the user queue and initiates the processing of each user.
async function processQueue(): Promise<void> {
    const [data] = queue;

    const [userId] = Object.keys(data);
    const [channel, message] = data[userId];

    const proccessingMessage = `<@${message.author.id}> proccessing user with ID: ${userId}`;

    // Notifies that the user with ID is being processed.
    const newMsg = await channel.send(`${proccessingMessage}`);

    // Uses Bun's Spawn API to initiate score calculation
    const clientId = process.env.OSU_CLIENT_ID;
    const clientSecret = process.env.OSU_CLIENT_SECRET;
    const subprocess = Bun.spawn(["dotnet", "run", "--", "profile", userId, clientId, clientSecret, "-o", `../../scores/${userId}.json`, "-j"], {
        cwd: "./performanceCalculator/osu-tools/PerformanceCalculator", // Set the working directory
        stdout: "pipe" // Pipes the stdout so it can be read from
    });

    let idx = 0;
    const reader = subprocess.stdout.getReader();
    while (true) {
        const { done, value } = await reader.read();
        const text = new TextDecoder().decode(value);
        console.log(text);
        console.log(done);
        if (idx % 15 === 0) await newMsg.edit(`${proccessingMessage} (${idx}%)`);
        if (done || text.includes("\"Username\"")) {
            console.log("DONE!");
            await processScores(userId, channel, message, newMsg);
            break;
        }
        idx++;
    }

    // Shift the processed user from the queue.
    queue.shift();

    // If there are more users in the queue, continue processing.
    if (queue.length > 0)
        await processQueue();
}

// Runs the command, adding a user to the queue and initiating the processing if necessary.
async function run(message: Message): Promise<void> {
    if (!message.content) return;
    const channel = await message.fetchChannel();
    const [, userId] = message.content.split(" ");
    if (!userId) {
        await channel.send(`You need an osu!user ID or a username to use this command.
        Check [the guide](https://discord.com/channels/1129202618053435542/1191561884026015824/1191780350809083925) to see how to get it.`);
        return;
    }

    if (isNaN(+userId)) {
        await channel.send(`\`${userId}\` is not a valid user ID. Check [the guide](https://discord.com/channels/1129202618053435542/1191561884026015824/1191780350809083925) to see how to get your user id.`);
        return;
    }

    // Checks if the user is already in the queue.
    if (queue.some((entry) => Object.keys(entry)[0] === userId)) {
        const existingEntries = queue.filter((entry) => Object.keys(entry)[0] === userId);
        if (existingEntries.length === 0) return;

        const queuePlacement = queue.findIndex((entry) => Object.keys(entry)[0] === userId) + 1;
        const queueTime = queuePlacement * Math.floor((Math.random() + 1) * 36);
        const approxQueueTime = queueTime > 60 ? `${(queueTime / 60).toFixed(2)} minutes` : `${queueTime} seconds`;

        const lineInThisGuild = existingEntries.findIndex((x) => x[userId][1].guildId === message.guildId) !== -1;
        if (lineInThisGuild) {
            await channel.send(`The player with ID ${userId} is already in line for this guild. (#${queuePlacement}, ${approxQueueTime})`);
            return;
        }
        await channel.send(`The player with ID ${userId} is already in line for another guild, adding to queue. (#${queuePlacement}, ${approxQueueTime})`);

        queue.push({ [userId]: [channel, message] });

        return;
    }

    // Add the user to the queue.
    queue.push({ [userId]: [channel, message] });

    // Start processing.
    await processQueue();
}

export default {
    name: "calculate",
    run
} satisfies MessageCommand;
