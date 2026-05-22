import { getChannelMessage, type Message } from "../internal/discord.js";
import { type DiscordChannelInfo } from "./message-utils.js";
export declare function hydrateDiscordMessageIfNeeded(params: {
    client: {
        rest: Parameters<typeof getChannelMessage>[0];
    };
    message: Message;
    messageChannelId: string;
    channelInfo?: DiscordChannelInfo | null;
}): Promise<Message>;
