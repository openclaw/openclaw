import { s as ReplyPayload$1 } from "./get-reply-options.types-DiZecFJG.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";

//#region src/channels/plugins/media-payload.d.ts
type MediaPayloadInput = {
  path: string;
  contentType?: string;
};
type MediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};
declare function buildMediaPayload(mediaList: MediaPayloadInput[], opts?: {
  preserveMediaTypeCardinality?: boolean;
}): MediaPayload;
//#endregion
//#region src/plugin-sdk/reply-payload.d.ts
type ReplyPayload = Omit<ReplyPayload$1, "trustedLocalMedia">;
type OutboundReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  presentation?: ReplyPayload$1["presentation"];
  /**
   * @deprecated Use presentation. Runtime support remains for legacy producers.
   */
  interactive?: ReplyPayload$1["interactive"];
  channelData?: ReplyPayload$1["channelData"];
  sensitiveMedia?: boolean;
  replyToId?: string;
};
type ReasoningReplyPayload = {
  text?: string;
  isReasoning?: boolean;
};
type SendableOutboundReplyParts = {
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
declare function isReasoningReplyPayload(payload: ReasoningReplyPayload): boolean;
/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
declare function normalizeOutboundReplyPayload(payload: Record<string, unknown>): OutboundReplyPayload;
/** Wrap a deliverer so callers can hand it arbitrary payloads while channels receive normalized data. */
declare function createNormalizedOutboundDeliverer(handler: (payload: OutboundReplyPayload) => Promise<void>): (payload: unknown) => Promise<void>;
/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
declare function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[];
/** Resolve media URLs from a channel sendPayload context after legacy fallback normalization. */
declare function resolvePayloadMediaUrls(payload: SendPayloadContext["payload"]): string[];
/** Count outbound media items after legacy single-media fallback normalization. */
declare function countOutboundMedia(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): number;
/** Check whether an outbound payload includes any media after normalization. */
declare function hasOutboundMedia(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): boolean;
/** Check whether an outbound payload includes text, optionally trimming whitespace first. */
declare function hasOutboundText(payload: {
  text?: string;
}, options?: {
  trim?: boolean;
}): boolean;
/** Check whether an outbound payload includes any sendable text, media, or rich reply content. */
declare function hasOutboundReplyContent(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
}, options?: {
  trimText?: boolean;
}): boolean;
/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
declare function resolveSendableOutboundReplyParts(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}, options?: {
  text?: string;
}): SendableOutboundReplyParts;
/** Preserve caller-provided chunking, but fall back to the full text when chunkers return nothing. */
declare function resolveTextChunksWithFallback(text: string, chunks: readonly string[]): string[];
/** Send media-first payloads intact, or chunk text-only payloads through the caller's transport hooks. */
declare function sendPayloadWithChunkedTextAndMedia<TContext extends {
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
declare function sendPayloadMediaSequence<TResult>(params: {
  text: string;
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TResult>;
}): Promise<TResult | undefined>;
declare function sendPayloadMediaSequenceOrFallback<TResult>(params: {
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
declare function sendPayloadMediaSequenceAndFinalize<TMediaResult, TResult>(params: {
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
declare function sendTextMediaPayload(params: {
  channel: string;
  ctx: SendPayloadContext;
  adapter: SendPayloadAdapter;
}): Promise<SendPayloadResult>;
/** Detect numeric-looking target ids for channels that distinguish ids from handles. */
declare function isNumericTargetId(raw: string): boolean;
/** Append attachment links to plain text when the channel cannot send media inline. */
declare function formatTextWithAttachmentLinks(text: string | undefined, mediaUrls: string[]): string;
/** Send a caption with only the first media item, mirroring caption-limited channel transports. */
declare function sendMediaWithLeadingCaption(params: {
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
declare function deliverTextOrMediaReply(params: {
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
declare function deliverFormattedTextWithAttachments(params: {
  payload: OutboundReplyPayload;
  send: (params: {
    text: string;
    replyToId?: string;
  }) => Promise<void>;
}): Promise<boolean>;
//#endregion
export { sendPayloadMediaSequenceOrFallback as C, MediaPayloadInput as D, MediaPayload as E, buildMediaPayload as O, sendPayloadMediaSequenceAndFinalize as S, sendTextMediaPayload as T, resolvePayloadMediaUrls as _, countOutboundMedia as a, sendMediaWithLeadingCaption as b, deliverTextOrMediaReply as c, hasOutboundReplyContent as d, hasOutboundText as f, resolveOutboundMediaUrls as g, normalizeOutboundReplyPayload as h, SendableOutboundReplyParts as i, formatTextWithAttachmentLinks as l, isReasoningReplyPayload as m, ReasoningReplyPayload as n, createNormalizedOutboundDeliverer as o, isNumericTargetId as p, ReplyPayload as r, deliverFormattedTextWithAttachments as s, OutboundReplyPayload as t, hasOutboundMedia as u, resolveSendableOutboundReplyParts as v, sendPayloadWithChunkedTextAndMedia as w, sendPayloadMediaSequence as x, resolveTextChunksWithFallback as y };