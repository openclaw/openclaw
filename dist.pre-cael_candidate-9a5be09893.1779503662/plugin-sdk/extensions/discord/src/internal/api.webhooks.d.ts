import type { RequestClient, RequestData } from "./rest.js";
export declare function createChannelWebhook(rest: RequestClient, channelId: string, data: RequestData): Promise<{
    id?: string;
    token?: string;
}>;
