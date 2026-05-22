import type { MarkdownTableMode, OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { RequestClient } from "../internal/discord.js";
export type DiscordThreadBindingLookupRecord = {
    accountId: string;
    channelId: string;
    threadId: string;
    agentId: string;
    label?: string;
    webhookId?: string;
    webhookToken?: string;
};
export type DiscordThreadBindingLookup = {
    listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
    touchThread?: (params: {
        threadId: string;
        at?: number;
        persist?: boolean;
    }) => unknown;
};
export declare function deliverDiscordReply(params: {
    cfg: OpenClawConfig;
    replies: ReplyPayload[];
    target: string;
    token: string;
    accountId?: string;
    rest?: RequestClient;
    runtime: RuntimeEnv;
    textLimit: number;
    maxLinesPerMessage?: number;
    replyToId?: string;
    replyToMode?: ReplyToMode;
    tableMode?: MarkdownTableMode;
    chunkMode?: ChunkMode;
    sessionKey?: string;
    threadBindings?: DiscordThreadBindingLookup;
    mediaLocalRoots?: readonly string[];
    kind: "tool" | "block" | "final";
}): Promise<void>;
