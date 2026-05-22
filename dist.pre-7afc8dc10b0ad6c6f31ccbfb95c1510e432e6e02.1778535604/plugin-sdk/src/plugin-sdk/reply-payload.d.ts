import type { ReplyPayload as InternalReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
export type { MediaPayload, MediaPayloadInput } from "../channels/plugins/media-payload.js";
export { buildMediaPayload } from "../channels/plugins/media-payload.js";
export type ReplyPayload = Omit<InternalReplyPayload, "trustedLocalMedia">;
export type OutboundReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    sensitiveMedia?: boolean;
    replyToId?: string;
};
export type ReasoningReplyPayload = {
    text?: string;
    isReasoning?: boolean;
};
export type SendableOutboundReplyParts = {
    text: string;
    trimmedText: string;
    mediaUrls: string[];
    mediaCount: number;
    hasText: boolean;
    hasMedia: boolean;
    hasContent: boolean;
};
type SendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type SendPayloadResult = Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>;
type SendPayloadAdapter = Pick<ChannelOutboundAdapter, "sendMedia" | "sendText" | "chunker" | "textChunkLimit">;
export declare function isReasoningReplyPayload(payload: ReasoningReplyPayload): boolean;
/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export declare function normalizeOutboundReplyPayload(payload: Record<string, unknown>): OutboundReplyPayload;
/** Wrap a deliverer so callers can hand it arbitrary payloads while channels receive normalized data. */
export declare function createNormalizedOutboundDeliverer(handler: (payload: OutboundReplyPayload) => Promise<void>): (payload: unknown) => Promise<void>;
/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
export declare function resolveOutboundMediaUrls(payload: {
    mediaUrls?: string[];
    mediaUrl?: string;
}): string[];
/** Resolve media URLs from a channel sendPayload context after legacy fallback normalization. */
export declare function resolvePayloadMediaUrls(payload: SendPayloadContext["payload"]): string[];
/** Count outbound media items after legacy single-media fallback normalization. */
export declare function countOutboundMedia(payload: {
    mediaUrls?: string[];
    mediaUrl?: string;
}): number;
/** Check whether an outbound payload includes any media after normalization. */
export declare function hasOutboundMedia(payload: {
    mediaUrls?: string[];
    mediaUrl?: string;
}): boolean;
/** Check whether an outbound payload includes text, optionally trimming whitespace first. */
export declare function hasOutboundText(payload: {
    text?: string;
}, options?: {
    trim?: boolean;
}): boolean;
/** Check whether an outbound payload includes any sendable text or media. */
export declare function hasOutboundReplyContent(payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
}, options?: {
    trimText?: boolean;
}): boolean;
/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export declare function resolveSendableOutboundReplyParts(payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
}, options?: {
    text?: string;
}): SendableOutboundReplyParts;
/** Preserve caller-provided chunking, but fall back to the full text when chunkers return nothing. */
export declare function resolveTextChunksWithFallback(text: string, chunks: readonly string[]): string[];
/** Send media-first payloads intact, or chunk text-only payloads through the caller's transport hooks. */
export declare function sendPayloadWithChunkedTextAndMedia<TContext extends {
    payload: object;
}, TResult>(params: {
    ctx: TContext;
    textChunkLimit?: number;
    chunker?: ((text: string, limit: number) => string[]) | null;
    sendText: (ctx: TContext & {
        text: string;
    }) => Promise<TResult>;
    sendMedia: (ctx: TContext & {
        text: string;
        mediaUrl: string;
    }) => Promise<TResult>;
    emptyResult: TResult;
}): Promise<TResult>;
export declare function sendPayloadMediaSequence<TResult>(params: {
    text: string;
    mediaUrls: readonly string[];
    send: (input: {
        text: string;
        mediaUrl: string;
        index: number;
        isFirst: boolean;
    }) => Promise<TResult>;
}): Promise<TResult | undefined>;
export declare function sendPayloadMediaSequenceOrFallback<TResult>(params: {
    text: string;
    mediaUrls: readonly string[];
    send: (input: {
        text: string;
        mediaUrl: string;
        index: number;
        isFirst: boolean;
    }) => Promise<TResult>;
    fallbackResult: TResult;
    sendNoMedia?: () => Promise<TResult>;
}): Promise<TResult>;
export declare function sendPayloadMediaSequenceAndFinalize<TMediaResult, TResult>(params: {
    text: string;
    mediaUrls: readonly string[];
    send: (input: {
        text: string;
        mediaUrl: string;
        index: number;
        isFirst: boolean;
    }) => Promise<TMediaResult>;
    finalize: () => Promise<TResult>;
}): Promise<TResult>;
export declare function sendTextMediaPayload(params: {
    channel: string;
    ctx: SendPayloadContext;
    adapter: SendPayloadAdapter;
}): Promise<SendPayloadResult>;
/** Detect numeric-looking target ids for channels that distinguish ids from handles. */
export declare function isNumericTargetId(raw: string): boolean;
/** Append attachment links to plain text when the channel cannot send media inline. */
export declare function formatTextWithAttachmentLinks(text: string | undefined, mediaUrls: string[]): string;
/** Send a caption with only the first media item, mirroring caption-limited channel transports. */
export declare function sendMediaWithLeadingCaption(params: {
    mediaUrls: string[];
    caption: string;
    send: (payload: {
        mediaUrl: string;
        caption?: string;
    }) => Promise<void>;
    onError?: (params: {
        error: unknown;
        mediaUrl: string;
        caption?: string;
        index: number;
        isFirst: boolean;
    }) => Promise<void> | void;
}): Promise<boolean>;
export declare function deliverTextOrMediaReply(params: {
    payload: OutboundReplyPayload;
    text: string;
    chunkText?: (text: string) => readonly string[];
    sendText: (text: string) => Promise<void>;
    sendMedia: (payload: {
        mediaUrl: string;
        caption?: string;
    }) => Promise<void>;
    onMediaError?: (params: {
        error: unknown;
        mediaUrl: string;
        caption?: string;
        index: number;
        isFirst: boolean;
    }) => Promise<void> | void;
}): Promise<"empty" | "text" | "media">;
export declare function deliverFormattedTextWithAttachments(params: {
    payload: OutboundReplyPayload;
    send: (params: {
        text: string;
        replyToId?: string;
    }) => Promise<void>;
}): Promise<boolean>;
