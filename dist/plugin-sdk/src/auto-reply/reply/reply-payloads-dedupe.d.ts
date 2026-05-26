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
export declare function shouldDedupeMessagingToolRepliesForRoute(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): boolean;
export declare function getMatchingMessagingToolReplyTargets(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): MessagingToolSend[];
export type MessagingToolPayloadDedupeDecision = {
    shouldDedupePayloads: boolean;
    matchingRoute: boolean;
    routeSentTexts: string[];
    routeSentMediaUrls: string[];
    useGlobalSentTextEvidenceFallback: boolean;
    useGlobalSentMediaUrlEvidenceFallback: boolean;
};
export declare function resolveMessagingToolPayloadDedupe(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): MessagingToolPayloadDedupeDecision;
