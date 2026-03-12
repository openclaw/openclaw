import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
export declare function deliverReplies(params: {
    replies: ReplyPayload[];
    target: string;
    token: string;
    accountId?: string;
    runtime: RuntimeEnv;
    textLimit: number;
    replyThreadTs?: string;
    replyToMode: "off" | "first" | "all";
}): Promise<void>;
export type SlackRespondFn = (payload: {
    text: string;
    response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;
/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export declare function resolveSlackThreadTs(params: {
    replyToMode: "off" | "first" | "all";
    incomingThreadTs: string | undefined;
    messageTs: string | undefined;
    hasReplied: boolean;
    isThreadReply?: boolean;
}): string | undefined;
type SlackReplyDeliveryPlan = {
    nextThreadTs: () => string | undefined;
    markSent: () => void;
};
export declare function createSlackReplyDeliveryPlan(params: {
    replyToMode: "off" | "first" | "all";
    incomingThreadTs: string | undefined;
    messageTs: string | undefined;
    hasRepliedRef: {
        value: boolean;
    };
    isThreadReply?: boolean;
}): SlackReplyDeliveryPlan;
export declare function deliverSlackSlashReplies(params: {
    replies: ReplyPayload[];
    respond: SlackRespondFn;
    ephemeral: boolean;
    textLimit: number;
    tableMode?: MarkdownTableMode;
    chunkMode?: ChunkMode;
}): Promise<void>;
export {};
