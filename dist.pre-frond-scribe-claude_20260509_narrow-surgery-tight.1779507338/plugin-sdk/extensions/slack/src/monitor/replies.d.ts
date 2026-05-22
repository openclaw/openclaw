import type { MessageMetadata } from "@slack/types";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type SlackSendIdentity } from "./send.runtime.js";
export declare function readSlackReplyBlocks(payload: ReplyPayload): import("@openclaw/slack/api.ts.js").SlackBlock[] | undefined;
export declare function resolveDeliveredSlackReplyThreadTs(params: {
    replyToMode: "off" | "first" | "all" | "batched";
    payloadReplyToId?: string;
    replyThreadTs?: string;
}): string | undefined;
export declare function deliverReplies(params: {
    cfg: OpenClawConfig;
    replies: ReplyPayload[];
    target: string;
    token: string;
    accountId?: string;
    runtime: RuntimeEnv;
    textLimit: number;
    replyThreadTs?: string;
    replyToMode: "off" | "first" | "all" | "batched";
    identity?: SlackSendIdentity;
    metadata?: MessageMetadata;
}): Promise<void>;
export type SlackRespondFn = (payload: {
    text: string;
    blocks?: ReturnType<typeof readSlackReplyBlocks>;
    response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;
/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export declare function resolveSlackThreadTs(params: {
    replyToMode: "off" | "first" | "all" | "batched";
    incomingThreadTs: string | undefined;
    messageTs: string | undefined;
    hasReplied: boolean;
    isThreadReply?: boolean;
}): string | undefined;
type SlackReplyDeliveryPlan = {
    peekThreadTs: () => string | undefined;
    nextThreadTs: () => string | undefined;
    markSent: () => void;
};
export declare function createSlackReplyDeliveryPlan(params: {
    replyToMode: "off" | "first" | "all" | "batched";
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
