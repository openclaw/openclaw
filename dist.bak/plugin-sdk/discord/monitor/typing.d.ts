import type { Client } from "@buape/carbon";
export declare function sendTyping(params: {
    client: Client;
    channelId: string;
}): Promise<void>;
