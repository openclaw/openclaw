import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../types.js";
export declare function createSlackThreadTsResolver(params: {
    client: SlackWebClient;
    cacheTtlMs?: number;
    maxSize?: number;
}): {
    resolve: (request: {
        message: SlackMessageEvent;
        source: "message" | "app_mention";
    }) => Promise<SlackMessageEvent>;
};
