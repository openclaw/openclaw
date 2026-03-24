import type { SlackMessageEvent } from "../types.js";
import type { SlackChannelConfigResolved } from "./channel-config.js";
export declare function isResolvedSlackIncidentUpdateText(rawBody: string | null | undefined): boolean;
export declare function resolveSlackIncidentIngressDrop(params: {
    accountId: string;
    allowApprovedHumanThreadFollowups?: boolean;
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
