import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type OutboundMediaAccess, type PollInput } from "openclaw/plugin-sdk/media-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { createDiscordClient, resolveDiscordRest, type DiscordClientOpts } from "./client.js";
import { RequestClient } from "./internal/discord.js";
type DiscordRequest = RetryRunner;
export { buildDiscordMessagePayload, buildDiscordMessageRequest, resolveDiscordMessageFlags, resolveDiscordSendComponents, resolveDiscordSendEmbeds, stripUndefinedFields, SUPPRESS_EMBEDS_FLAG, SUPPRESS_NOTIFICATIONS_FLAG, type DiscordSendComponentFactory, type DiscordSendComponents, type DiscordSendEmbeds, } from "./send.message-request.js";
import { type DiscordSendComponents, type DiscordSendEmbeds } from "./send.message-request.js";
type DiscordRecipient = {
    kind: "user";
    id: string;
} | {
    kind: "channel";
    id: string;
};
declare function normalizeReactionEmoji(raw: string): string;
declare function normalizeStickerIds(raw: string[]): string[];
declare function normalizeEmojiName(raw: string, label: string): string;
declare function normalizeDiscordPollInput(input: PollInput): RESTAPIPoll;
declare function buildDiscordSendError(err: unknown, ctx: {
    channelId: string;
    cfg: OpenClawConfig;
    rest: RequestClient;
    token: string;
    hasMedia: boolean;
}): Promise<unknown>;
declare function resolveChannelId(rest: RequestClient, recipient: DiscordRecipient, request: DiscordRequest): Promise<{
    channelId: string;
    dm?: boolean;
}>;
declare function resolveDiscordTargetChannelId(raw: string, opts: DiscordClientOpts & {
    cfg: OpenClawConfig;
}): Promise<{
    channelId: string;
    dm?: boolean;
}>;
export declare function resolveDiscordChannelType(rest: RequestClient, channelId: string): Promise<number | undefined>;
export declare function buildDiscordTextChunks(text: string, opts?: {
    maxLinesPerMessage?: number;
    chunkMode?: ChunkMode;
    maxChars?: number;
}): string[];
export declare function toDiscordFileBlob(data: Blob | Uint8Array): Blob;
declare function sendDiscordText(rest: RequestClient, channelId: string, text: string, replyTo: string | undefined, request: DiscordRequest, maxLinesPerMessage?: number, components?: DiscordSendComponents, embeds?: DiscordSendEmbeds, chunkMode?: ChunkMode, silent?: boolean, suppressEmbeds?: boolean, maxChars?: number): Promise<{
    id: string;
    channel_id: string;
    platformMessageIds: string[];
}>;
declare function sendDiscordMedia(rest: RequestClient, channelId: string, text: string, mediaUrl: string, filename: string | undefined, mediaAccess: OutboundMediaAccess | undefined, mediaLocalRoots: readonly string[] | undefined, mediaReadFile: ((filePath: string) => Promise<Buffer>) | undefined, maxBytes: number | undefined, replyTo: string | undefined, request: DiscordRequest, maxLinesPerMessage?: number, components?: DiscordSendComponents, embeds?: DiscordSendEmbeds, chunkMode?: ChunkMode, silent?: boolean, suppressEmbeds?: boolean, maxChars?: number): Promise<{
    id: string;
    channel_id: string;
    platformMessageIds: string[];
}>;
declare function buildReactionIdentifier(emoji: {
    id?: string | null;
    name?: string | null;
}): string;
declare function formatReactionEmoji(emoji: {
    id?: string | null;
    name?: string | null;
}): string;
export { buildDiscordSendError, buildReactionIdentifier, createDiscordClient, formatReactionEmoji, normalizeDiscordPollInput, normalizeEmojiName, normalizeReactionEmoji, normalizeStickerIds, resolveChannelId, resolveDiscordTargetChannelId, resolveDiscordRest, sendDiscordMedia, sendDiscordText, };
