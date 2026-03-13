import type { SlackMessageEvent } from "../types.js";
import type { SlackChannelConfigResolved } from "./channel-config.js";
export declare function resolveSlackIncidentIngressDrop(params: {
    accountId: string;
    channelConfig: SlackChannelConfigResolved | null;
    channelId: string;
    dedupeStore: Map<string, number>;
    message: SlackMessageEvent;
    now?: number;
    rawBody: string;
}): {
    reason?: string;
    shouldDrop: boolean;
};
