import { type MessageReceipt } from "openclaw/plugin-sdk/channel-message";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import type { WhatsAppSendResult } from "../inbound/send-result.js";
import { type DeliverableWhatsAppOutboundPayload } from "../outbound-media-contract.js";
import type { WebInboundMsg } from "./types.js";
export type WhatsAppReplyDeliveryResult = {
    results: WhatsAppSendResult[];
    receipt: MessageReceipt;
    providerAccepted: boolean;
};
export declare function deliverWebReply(params: {
    replyResult: ReplyPayload;
    normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
    msg: WebInboundMsg;
    mediaLocalRoots?: readonly string[];
    maxMediaBytes: number;
    textLimit: number;
    chunkMode?: ChunkMode;
    replyLogger: {
        info: (obj: unknown, msg: string) => void;
        warn: (obj: unknown, msg: string) => void;
    };
    connectionId?: string;
    skipLog?: boolean;
    tableMode?: MarkdownTableMode;
}): Promise<WhatsAppReplyDeliveryResult>;
