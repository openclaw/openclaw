import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess, PollInput } from "openclaw/plugin-sdk/media-runtime";
import { type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { type RequestClient } from "./internal/discord.js";
import { type DiscordSendComponents, type DiscordSendEmbeds } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
type DiscordSendOpts = {
    cfg: OpenClawConfig;
    token?: string;
    accountId?: string;
    mediaUrl?: string;
    filename?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    verbose?: boolean;
    rest?: RequestClient;
    replyTo?: string;
    retry?: RetryConfig;
    textLimit?: number;
    maxLinesPerMessage?: number;
    tableMode?: MarkdownTableMode;
    chunkMode?: ChunkMode;
    components?: DiscordSendComponents;
    embeds?: DiscordSendEmbeds;
    silent?: boolean;
    suppressEmbeds?: boolean;
};
export declare function sendMessageDiscord(to: string, text: string, opts: DiscordSendOpts): Promise<DiscordSendResult>;
export declare function sendStickerDiscord(to: string, stickerIds: string[], opts: DiscordSendOpts & {
    content?: string;
}): Promise<DiscordSendResult>;
export declare function sendPollDiscord(to: string, poll: PollInput, opts: DiscordSendOpts & {
    content?: string;
}): Promise<DiscordSendResult>;
export {};
