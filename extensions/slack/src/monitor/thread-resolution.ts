import {
  type WebClient as SlackWebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  parseFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { classifyTransientNetworkErrorCode } from "openclaw/plugin-sdk/retry-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString as normalizeThreadTs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";

type ThreadTsCacheEntry = {
  threadTs: string | null;
  /** True when the provider located the message, including a threadless root. */
  found: boolean;
  /** Root message text, retained so a cache hit can re-run the seed decision. */
  rootText?: string;
  expiresAt: number;
};

const DEFAULT_THREAD_TS_CACHE_TTL_MS = 60_000;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;

const markAmbiguousThreadReply = (message: SlackMessageEvent): SlackMessageEvent => ({
  ...message,
  _ambiguousThreadReply: true,
});

export function isTransientSlackThreadLookupError(error: unknown): boolean {
  if (error instanceof WebAPIRateLimitedError) {
    return true;
  }
  if (error instanceof WebAPIHTTPError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode < 600)
    );
  }
  // Slack documents these users.info response codes as transient service failures.
  if (error instanceof WebAPIPlatformError) {
    return error.data.error === "internal_error" || error.data.error === "service_unavailable";
  }
  if (!(error instanceof WebAPIRequestError)) {
    return false;
  }
  // Slack Web API 8.0.0 wraps exhausted 429 retries as this uncoded request error.
  if (/^A rate limit was exceeded \(url: .+, retry-after: \d+\)$/.test(error.original.message)) {
    return true;
  }
  return collectErrorGraphCandidates(error.original, (current) => [
    current.cause,
    current.error,
    current.original,
  ]).some(
    (candidate) =>
      classifyTransientNetworkErrorCode(extractErrorCode(candidate)) ||
      readErrorName(candidate) === "TimeoutError",
  );
}

type SlackThreadLookup = { threadTs?: string; text?: string };

const readThreadIdentity = (
  entry: { thread_ts?: string; text?: string } | undefined,
): SlackThreadLookup | undefined =>
  entry
    ? {
        threadTs: normalizeThreadTs(entry.thread_ts),
        text: typeof entry.text === "string" ? entry.text : undefined,
      }
    : undefined;

async function resolveThreadFromSlack(params: {
  client: SlackWebClient;
  channelId: string;
  messageTs: string;
}): Promise<SlackThreadLookup | undefined> {
  const history = await params.client.conversations.history({
    channel: params.channelId,
    latest: params.messageTs,
    oldest: params.messageTs,
    inclusive: true,
    limit: 1,
  });
  const fromHistory =
    history.messages?.find((entry) => entry.ts === params.messageTs) ?? history.messages?.[0];
  if (fromHistory) {
    return readThreadIdentity(fromHistory);
  }
  // conversations.history never returns thread replies, so a missed target is read
  // through the thread API; conversations.replies accepts the ts of any message in
  // the thread, including the reply itself.
  const replies = await params.client.conversations.replies({
    channel: params.channelId,
    ts: params.messageTs,
    latest: params.messageTs,
    oldest: params.messageTs,
    inclusive: true,
    limit: 1,
  });
  return readThreadIdentity(replies.messages?.find((entry) => entry.ts === params.messageTs));
}

export function createSlackThreadTsResolver(params: {
  client: SlackWebClient;
  cacheTtlMs?: number;
  maxSize?: number;
}) {
  const ttlMs = Math.max(0, parseFiniteNumber(params.cacheTtlMs) ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
  const maxSize = Math.max(0, parseFiniteNumber(params.maxSize) ?? DEFAULT_THREAD_TS_CACHE_MAX);
  const cache = new Map<string, ThreadTsCacheEntry>();
  const inflight = new Map<string, Promise<SlackThreadLookup | undefined>>();

  const getCached = (key: string, now: number) => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt === 0) {
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    }
    const normalizedNow = asDateTimestampMs(now);
    if (
      normalizedNow === undefined ||
      asDateTimestampMs(entry.expiresAt) === undefined ||
      entry.expiresAt <= normalizedNow
    ) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  };

  const setCached = (key: string, value: Omit<ThreadTsCacheEntry, "expiresAt">, now: number) => {
    const expiresAt = ttlMs > 0 ? resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) : 0;
    if (expiresAt === undefined) {
      cache.delete(key);
      return;
    }
    cache.delete(key);
    cache.set(key, { ...value, expiresAt });
    pruneMapToMaxSize(cache, maxSize);
  };

  // One bounded lookup owns (channel, message) -> thread identity. Every caller shares
  // it so a repeated question lands in the same cache and in-flight dedupe; only an
  // answer the provider stands behind is cached.
  const lookupThreadTs = async (request: {
    channelId: string;
    messageTs: string;
  }): Promise<{
    threadTs: string | undefined;
    found: boolean;
    rootText: string | undefined;
    fromCache: boolean;
    error?: unknown;
  }> => {
    const cacheKey = `${request.channelId}:${request.messageTs}`;
    const cached = getCached(cacheKey, Date.now());
    if (cached !== undefined) {
      return {
        threadTs: cached.threadTs ?? undefined,
        found: cached.found,
        rootText: cached.rootText,
        fromCache: true,
      };
    }

    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = resolveThreadFromSlack({
        client: params.client,
        channelId: request.channelId,
        messageTs: request.messageTs,
      });
      inflight.set(cacheKey, pending);
    }

    try {
      const resolved = await pending;
      const isRoot =
        resolved !== undefined && (!resolved.threadTs || resolved.threadTs === request.messageTs);
      setCached(
        cacheKey,
        {
          threadTs: resolved?.threadTs ?? null,
          found: resolved !== undefined,
          rootText: isRoot ? resolved?.text : undefined,
        },
        Date.now(),
      );
      return {
        threadTs: resolved?.threadTs,
        found: resolved !== undefined,
        rootText: isRoot ? resolved?.text : undefined,
        fromCache: false,
      };
    } catch (error) {
      // A definitive failure (unknown message, denied read, malformed response) is
      // cached like an unresolved lookup; a transient one stays uncached so the next
      // caller may retry instead of inheriting a poisoned answer.
      if (!isTransientSlackThreadLookupError(error)) {
        setCached(cacheKey, { threadTs: null, found: false }, Date.now());
      }
      return { threadTs: undefined, found: false, rootText: undefined, fromCache: false, error };
    } finally {
      inflight.delete(cacheKey);
    }
  };

  return {
    /**
     * Resolves one message's thread root for a caller that owns no durable inbound
     * retry. A failed lookup leaves the question open instead of inventing a lane.
     */
    resolveThreadTs: async (request: {
      channelId: string;
      messageTs: string;
      /**
       * Decides the owning session when the target turns out to be a top-level
       * thread root. Inbound routing seeds only eligible roots (mentions, implicit
       * threading) into :thread:<root> and keeps the rest on the channel session,
       * so the caller mirrors that decision from channel config and the root's
       * text. When omitted, every root keeps the parent channel session.
       */
      resolveSeededRootThreadId?: (root: {
        ts: string;
        threadTs?: string;
        text?: string;
      }) => Promise<string | undefined> | string | undefined;
    }): Promise<string | undefined> => {
      const { threadTs, found, rootText, error } = await lookupThreadTs(request);
      if (error !== undefined && shouldLogVerbose()) {
        logVerbose(
          `slack: failed to resolve thread_ts for system event channel=${request.channelId} ts=${request.messageTs}: ${formatSlackError(error)}`,
        );
      }
      if (!found) {
        return undefined;
      }
      // A genuine reply always belongs to its thread's session: the inbound route
      // owner places every non-DM thread reply in :thread:<root> regardless of
      // replyToMode.
      if (threadTs && threadTs !== request.messageTs) {
        return threadTs;
      }
      // The target is a top-level root (Slack stamps a replied root with
      // thread_ts === ts). Root session ownership is a seeding decision, not a
      // provider fact, so defer to the caller's routing mirror. Direct messages
      // never reach this lookup — the system-event context skips it for im
      // channels, keeping flat DM sessions (and assistant DM roots) untouched.
      return (
        (await request.resolveSeededRootThreadId?.({
          ts: request.messageTs,
          threadTs,
          text: rootText,
        })) ?? undefined
      );
    },
    resolve: async (request: {
      message: SlackMessageEvent;
      source: "message" | "app_mention";
      turnAdoptionLifecycle?: SlackIngressTurnLifecycle;
    }): Promise<SlackMessageEvent> => {
      const { message } = request;
      if (!message.parent_user_id || message.thread_ts || !message.ts) {
        return message;
      }

      const {
        threadTs: resolved,
        fromCache,
        error,
      } = await lookupThreadTs({
        channelId: message.channel,
        messageTs: message.ts,
      });
      if (!fromCache && shouldLogVerbose()) {
        logVerbose(
          `slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`,
        );
      }
      if (error !== undefined) {
        if (shouldLogVerbose()) {
          logVerbose(
            `slack inbound: failed to resolve thread_ts for channel=${message.channel} ts=${message.ts}: ${formatSlackError(error)}`,
          );
        }
        if (isTransientSlackThreadLookupError(error)) {
          if (request.turnAdoptionLifecycle) {
            // The already-acknowledged durable ingress owner retries without dropping the turn.
            throw error;
          }
          return markAmbiguousThreadReply(message);
        }
      }

      if (resolved) {
        if (shouldLogVerbose()) {
          logVerbose(
            `slack inbound: resolved missing thread_ts channel=${message.channel} ts=${message.ts} -> thread_ts=${resolved}`,
          );
        }
        return { ...message, thread_ts: resolved };
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `slack inbound: could not resolve missing thread_ts channel=${message.channel} ts=${message.ts}; marking reply ambiguous`,
        );
      }
      return markAmbiguousThreadReply(message);
    },
  };
}

// Keep cache and in-flight lookups with Bolt's client; replaced clients start fresh.
const threadTsResolvers = new WeakMap<
  SlackWebClient,
  ReturnType<typeof createSlackThreadTsResolver>
>();

/** Returns the per-client resolver shared by inbound messages and system events. */
export function getSlackThreadTsResolver(client: SlackWebClient) {
  let resolver = threadTsResolvers.get(client);
  if (!resolver) {
    resolver = createSlackThreadTsResolver({ client });
    threadTsResolvers.set(client, resolver);
  }
  return resolver;
}
