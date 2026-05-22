import { type RequestClient } from "../internal/discord.js";
export declare function sendTyping(params: {
    rest: RequestClient;
    channelId: string;
}): Promise<void>;
