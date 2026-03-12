import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { shouldSuppressMessagingToolReplies } from "./reply-payloads.js";
export declare function buildReplyPayloads(params: {
    payloads: ReplyPayload[];
    isHeartbeat: boolean;
    didLogHeartbeatStrip: boolean;
    blockStreamingEnabled: boolean;
    blockReplyPipeline: BlockReplyPipeline | null;
    /** Payload keys sent directly (not via pipeline) during tool flush. */
    directlySentBlockKeys?: Set<string>;
    replyToMode: ReplyToMode;
    replyToChannel?: OriginatingChannelType;
    currentMessageId?: string;
    messageProvider?: string;
    messagingToolSentTexts?: string[];
    messagingToolSentMediaUrls?: string[];
    messagingToolSentTargets?: Parameters<typeof shouldSuppressMessagingToolReplies>[0]["messagingToolSentTargets"];
    originatingChannel?: OriginatingChannelType;
    originatingTo?: string;
    accountId?: string;
}): {
    replyPayloads: ReplyPayload[];
    didLogHeartbeatStrip: boolean;
};
