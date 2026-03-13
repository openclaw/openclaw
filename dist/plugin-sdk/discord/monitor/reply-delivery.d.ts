import type { RequestClient } from "@buape/carbon";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MarkdownTableMode, ReplyToMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
export type DiscordThreadBindingLookupRecord = {
    accountId: string;
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
}): Promise<void>;
