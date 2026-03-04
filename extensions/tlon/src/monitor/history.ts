import type { RuntimeEnv } from "openclaw/plugin-sdk/tlon";
import { extractMessageText } from "./utils.js";

/**
 * Format a number as @ud (with dots every 3 digits from the right)
 * e.g., 170141184507799509469114119040828178432 -> 170.141.184.507.799.509.469.114.119.040.828.178.432
 */
function formatUd(id: string | number): string {
  const str = String(id).replace(/\./g, ""); // Remove any existing dots
  const reversed = str.split("").toReversed();
  const chunks: string[] = [];
  for (let i = 0; i < reversed.length; i += 3) {
    chunks.push(
      reversed
        .slice(i, i + 3)
        .toReversed()
        .join(""),
    );
  }
  return chunks.toReversed().join(".");
}

export type TlonHistoryEntry = {
  author: string;
  content: string;
  timestamp: number;
  id?: string;
};

type TlonPostEssay = {
  author?: string;
  content?: unknown;
  sent?: number;
};

type TlonPostSeal = {
  id?: string;
};

type TlonPost = {
  essay?: TlonPostEssay;
  seal?: TlonPostSeal;
  "r-post"?: {
    set?: {
      essay?: TlonPostEssay;
      seal?: TlonPostSeal;
    };
  };
};

type TlonPostMap = Record<string, TlonPost>;

type TlonChannelHistoryResponse =
  | TlonPost[]
  | {
      posts?: TlonPostMap;
    }
  | TlonPostMap;

type TlonReplyMemo = {
  author?: string;
  content?: unknown;
  sent?: number;
};

type TlonReplySeal = {
  id?: string;
};

type TlonReply = {
  memo?: TlonReplyMemo;
  seal?: TlonReplySeal;
  "r-reply"?: {
    set?: {
      memo?: TlonReplyMemo;
      seal?: TlonReplySeal;
    };
  };
  id?: string;
};

type TlonReplyMap = Record<string, TlonReply>;

type TlonThreadHistoryResponse =
  | TlonReply[]
  | {
      replies?: TlonReply[] | TlonReplyMap;
    }
  | TlonReplyMap;

type TlonPostLike = TlonPost | TlonReply;

const messageCache = new Map<string, TlonHistoryEntry[]>();
const MAX_CACHED_MESSAGES = 100;

export function cacheMessage(channelNest: string, message: TlonHistoryEntry) {
  if (!messageCache.has(channelNest)) {
    messageCache.set(channelNest, []);
  }
  const cache = messageCache.get(channelNest);
  if (!cache) {
    return;
  }
  cache.unshift(message);
  if (cache.length > MAX_CACHED_MESSAGES) {
    cache.pop();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTlonPostLike(value: unknown): value is TlonPostLike {
  if (!isObject(value)) {
    return false;
  }

  const maybeEssay = (value as TlonPost).essay;
  const maybeMemo = (value as TlonReply).memo;

  if (!maybeEssay && !maybeMemo && !("r-post" in value) && !("r-reply" in value)) {
    return false;
  }

  return true;
}

function normalizeChannelHistoryResponse(data: unknown, runtime?: RuntimeEnv): TlonPost[] {
  if (!data) {
    return [];
  }

  const narrowed = data as TlonChannelHistoryResponse;

  if (Array.isArray(narrowed)) {
    return narrowed.filter(isTlonPostLike) as TlonPost[];
  }

  if (isObject(narrowed) && narrowed.posts && isObject(narrowed.posts)) {
    return Object.values(narrowed.posts).filter(isTlonPostLike) as TlonPost[];
  }

  if (isObject(narrowed)) {
    return Object.values(narrowed).filter(isTlonPostLike) as TlonPost[];
  }

  runtime?.log?.("[tlon] Unexpected channel history response shape, ignoring");
  return [];
}

function extractHistoryEntryFromPost(post: TlonPost): TlonHistoryEntry {
  const essay = post.essay ?? post["r-post"]?.set?.essay ?? {};
  const seal = post.seal ?? post["r-post"]?.set?.seal ?? {};

  const contentBlocks = Array.isArray(essay.content) ? essay.content : [];

  return {
    author: essay.author ?? "unknown",
    content: extractMessageText(contentBlocks),
    timestamp: essay.sent ?? Date.now(),
    id: seal.id,
  };
}

function normalizeThreadHistoryResponse(data: unknown, runtime?: RuntimeEnv): TlonReply[] {
  if (!data) {
    return [];
  }

  const narrowed = data as TlonThreadHistoryResponse;

  if (Array.isArray(narrowed)) {
    return narrowed.filter(isTlonPostLike) as TlonReply[];
  }

  if (isObject(narrowed) && narrowed.replies) {
    const replies = Array.isArray(narrowed.replies)
      ? narrowed.replies
      : isObject(narrowed.replies)
        ? Object.values(narrowed.replies)
        : [];
    return replies.filter(isTlonPostLike) as TlonReply[];
  }

  if (isObject(narrowed)) {
    return Object.values(narrowed).filter(isTlonPostLike) as TlonReply[];
  }

  runtime?.log?.("[tlon] Unexpected thread history response shape, ignoring");
  return [];
}

function extractHistoryEntryFromReply(reply: TlonReply): TlonHistoryEntry {
  const memo = reply.memo ?? reply["r-reply"]?.set?.memo ?? {};
  const seal = reply.seal ?? reply["r-reply"]?.set?.seal ?? {};

  const contentBlocks = Array.isArray(memo.content) ? memo.content : [];

  return {
    author: memo.author ?? "unknown",
    content: extractMessageText(contentBlocks),
    timestamp: memo.sent ?? Date.now(),
    id: seal.id ?? reply.id,
  };
}

export async function fetchChannelHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  try {
    const scryPath = `/channels/v4/${channelNest}/posts/newest/${count}/outline.json`;
    runtime?.log?.(`[tlon] Fetching history: ${scryPath}`);

    const data = await api.scry(scryPath);
    const posts = normalizeChannelHistoryResponse(data, runtime);

    const messages = posts.map(extractHistoryEntryFromPost).filter((msg) => msg.content);

    runtime?.log?.(
      `[tlon] Extracted ${messages.length} messages from history (from ${posts.length} posts)`,
    );
    return messages;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime?.log?.(`[tlon] Error fetching channel history: ${message}`);
    return [];
  }
}

export async function getChannelHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  const cache = messageCache.get(channelNest) ?? [];
  if (cache.length >= count) {
    runtime?.log?.(`[tlon] Using cached messages (${cache.length} available)`);
    return cache.slice(0, count);
  }

  runtime?.log?.(`[tlon] Cache has ${cache.length} messages, need ${count}, fetching from scry...`);
  return await fetchChannelHistory(api, channelNest, count, runtime);
}

/**
 * Fetch thread/reply history for a specific parent post.
 * Used to get context when entering a thread conversation.
 */
export async function fetchThreadHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  parentId: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  try {
    // Tlon API: fetch replies to a specific post
    // Format: /channels/v4/{nest}/posts/post/{parentId}/replies/newest/{count}.json
    // parentId needs @ud formatting (dots every 3 digits)
    const formattedParentId = formatUd(parentId);
    runtime?.log?.(
      `[tlon] Thread history - parentId: ${parentId} -> formatted: ${formattedParentId}`,
    );

    const scryPath = `/channels/v4/${channelNest}/posts/post/id/${formattedParentId}/replies/newest/${count}.json`;
    runtime?.log?.(`[tlon] Fetching thread history: ${scryPath}`);

    const data = await api.scry(scryPath);
    const replies = normalizeThreadHistoryResponse(data, runtime);

    const messages = replies.map(extractHistoryEntryFromReply).filter((msg) => msg.content);

    runtime?.log?.(
      `[tlon] Extracted ${messages.length} thread replies from history (from ${replies.length} replies)`,
    );
    return messages;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime?.log?.(`[tlon] Error fetching thread history: ${message}`);
    // Fall back to trying alternate path structure
    try {
      const altPath = `/channels/v4/${channelNest}/posts/post/id/${formatUd(parentId)}.json`;
      runtime?.log?.(`[tlon] Trying alternate path: ${altPath}`);
      const data = await api.scry(altPath);

      if (!isObject(data)) {
        return [];
      }

      const sealMeta = (data as { seal?: { meta?: { replyCount?: number } } }).seal?.meta;
      const hasReplies =
        typeof sealMeta?.replyCount === "number" && sealMeta.replyCount > 0 && "replies" in data;

      if (!hasReplies) {
        return [];
      }

      const rawReplies = (data as { replies?: unknown }).replies;
      const altReplies = normalizeThreadHistoryResponse(rawReplies, runtime);
      const messages = altReplies.map(extractHistoryEntryFromReply).filter((msg) => msg.content);

      runtime?.log?.(
        `[tlon] Extracted ${messages.length} replies from post data (from ${altReplies.length} replies)`,
      );
      return messages;
    } catch (altError) {
      const altMessage = altError instanceof Error ? altError.message : String(altError);
      runtime?.log?.(`[tlon] Alternate path also failed: ${altMessage}`);
    }
    return [];
  }
}
