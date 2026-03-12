import { Embed, RequestClient, type MessagePayloadFile, type MessagePayloadObject, type TopLevelComponents } from "@buape/carbon";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import { type APIEmbed } from "discord-api-types/v10";
import type { ChunkMode } from "../auto-reply/chunk.js";
import type { RetryRunner } from "../infra/retry-policy.js";
import { type PollInput } from "../polls.js";
import { createDiscordClient, resolveDiscordRest } from "./client.js";
type DiscordRequest = RetryRunner;
export type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;
type DiscordRecipient = {
    kind: "user";
    id: string;
} | {
    kind: "channel";
    id: string;
};
declare function normalizeReactionEmoji(raw: string): string;
declare function parseRecipient(raw: string): DiscordRecipient;
/**
 * Parse and resolve Discord recipient, including username lookup.
 * This enables sending DMs by username (e.g., "john.doe") by querying
 * the Discord directory to resolve usernames to user IDs.
 *
 * @param raw - The recipient string (username, ID, or known format)
 * @param accountId - Discord account ID to use for directory lookup
 * @returns Parsed DiscordRecipient with resolved user ID if applicable
 */
export declare function parseAndResolveRecipient(raw: string, accountId?: string): Promise<DiscordRecipient>;
declare function normalizeStickerIds(raw: string[]): string[];
declare function normalizeEmojiName(raw: string, label: string): string;
declare function normalizeDiscordPollInput(input: PollInput): RESTAPIPoll;
declare function buildDiscordSendError(err: unknown, ctx: {
    channelId: string;
    rest: RequestClient;
    token: string;
    hasMedia: boolean;
}): Promise<unknown>;
declare function resolveChannelId(rest: RequestClient, recipient: DiscordRecipient, request: DiscordRequest): Promise<{
    channelId: string;
    dm?: boolean;
}>;
export declare function resolveDiscordChannelType(rest: RequestClient, channelId: string): Promise<number | undefined>;
export declare const SUPPRESS_NOTIFICATIONS_FLAG: number;
export declare function buildDiscordTextChunks(text: string, opts?: {
    maxLinesPerMessage?: number;
    chunkMode?: ChunkMode;
    maxChars?: number;
}): string[];
export declare function resolveDiscordSendComponents(params: {
    components?: DiscordSendComponents;
    text: string;
    isFirst: boolean;
}): TopLevelComponents[] | undefined;
export declare function resolveDiscordSendEmbeds(params: {
    embeds?: DiscordSendEmbeds;
    isFirst: boolean;
}): Embed[] | undefined;
export declare function buildDiscordMessagePayload(params: {
    text: string;
    components?: TopLevelComponents[];
    embeds?: Embed[];
    flags?: number;
    files?: MessagePayloadFile[];
}): MessagePayloadObject;
export declare function stripUndefinedFields<T extends object>(value: T): T;
export declare function toDiscordFileBlob(data: Blob | Uint8Array): Blob;
declare function sendDiscordText(rest: RequestClient, channelId: string, text: string, replyTo: string | undefined, request: DiscordRequest, maxLinesPerMessage?: number, components?: DiscordSendComponents, embeds?: DiscordSendEmbeds, chunkMode?: ChunkMode, silent?: boolean): Promise<{
    id: string;
    channel_id: string;
}>;
declare function sendDiscordMedia(rest: RequestClient, channelId: string, text: string, mediaUrl: string, mediaLocalRoots: readonly string[] | undefined, replyTo: string | undefined, request: DiscordRequest, maxLinesPerMessage?: number, components?: DiscordSendComponents, embeds?: DiscordSendEmbeds, chunkMode?: ChunkMode, silent?: boolean): Promise<{
    id: string;
    channel_id: string;
}>;
declare function buildReactionIdentifier(emoji: {
    id?: string | null;
    name?: string | null;
}): string;
declare function formatReactionEmoji(emoji: {
    id?: string | null;
    name?: string | null;
}): string;
export { buildDiscordSendError, buildReactionIdentifier, createDiscordClient, formatReactionEmoji, normalizeDiscordPollInput, normalizeEmojiName, normalizeReactionEmoji, normalizeStickerIds, parseRecipient, resolveChannelId, resolveDiscordRest, sendDiscordMedia, sendDiscordText, };
