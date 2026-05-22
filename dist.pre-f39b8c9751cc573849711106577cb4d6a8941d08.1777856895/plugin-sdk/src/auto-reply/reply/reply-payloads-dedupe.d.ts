import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { ReplyPayload } from "../types.js";
export declare function filterMessagingToolDuplicates(params: {
    payloads: ReplyPayload[];
    sentTexts: string[];
}): ReplyPayload[];
export declare function filterMessagingToolMediaDuplicates(params: {
    payloads: ReplyPayload[];
    sentMediaUrls: string[];
}): ReplyPayload[];
export declare function shouldSuppressMessagingToolReplies(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): boolean;
export type MessagingToolPayloadDedupeDecision = {
    shouldDedupePayloads: boolean;
    suppressReplies: boolean;
};
export declare function resolveMessagingToolPayloadDedupe(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): MessagingToolPayloadDedupeDecision;
