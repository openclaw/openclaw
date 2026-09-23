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
import { resolveSlackThreadContext } from "../threading.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";

type ThreadTsCacheEntry = {
  threadTs: string | null;
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

async function resolveThreadTsFromSlack(params: {
  client: SlackWebClient;
  channelId: string;
  messageTs: string;
}) {
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
    return normalizeThreadTs(fromHistory.thread_ts);
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
  const fromReplies = replies.messages?.find((entry) => entry.ts === params.messageTs);
  return normalizeThreadTs(fromReplies?.thread_ts);
}

export function createSlackThreadTsResolver(params: {
  client: SlackWebClient;
  cacheTtlMs?: number;
  maxSize?: number;
}) {
  const ttlMs = Math.max(0, parseFiniteNumber(params.cacheTtlMs) ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
  const maxSize = Math.max(0, parseFiniteNumber(params.maxSize) ?? DEFAULT_THREAD_TS_CACHE_MAX);
  const cache = new Map<string, ThreadTsCacheEntry>();
  const inflight = new Map<string, Promise<string | undefined>>();

  const getCached = (key: string, now: number) => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt === 0) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.threadTs;
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
    return entry.threadTs;
  };

  const setCached = (key: string, threadTs: string | null, now: number) => {
    const expiresAt = ttlMs > 0 ? resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) : 0;
    if (expiresAt === undefined) {
      cache.delete(key);
      return;
    }
    cache.delete(key);
    cache.set(key, { threadTs, expiresAt });
    pruneMapToMaxSize(cache, maxSize);
  };

  // One bounded lookup owns (channel, message) -> thread_ts. Every caller shares it so
  // a repeated question lands in the same cache and in-flight dedupe; only an answer
  // the provider stands behind is cached.
  const lookupThreadTs = async (request: {
    channelId: string;
    messageTs: string;
  }): Promise<{ threadTs: string | undefined; fromCache: boolean; error?: unknown }> => {
    const cacheKey = `${request.channelId}:${request.messageTs}`;
    const cached = getCached(cacheKey, Date.now());
    if (cached !== undefined) {
      return { threadTs: cached ?? undefined, fromCache: true };
    }

    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = resolveThreadTsFromSlack({
        client: params.client,
        channelId: request.channelId,
        messageTs: request.messageTs,
      });
      inflight.set(cacheKey, pending);
    }

    try {
      const resolved = await pending;
      setCached(cacheKey, resolved ?? null, Date.now());
      return { threadTs: resolved, fromCache: false };
    } catch (error) {
      // A definitive failure (unknown message, denied read, malformed response) is
      // cached like an unresolved lookup; a transient one stays uncached so the next
      // caller may retry instead of inheriting a poisoned answer.
      if (!isTransientSlackThreadLookupError(error)) {
        setCached(cacheKey, null, Date.now());
      }
      return { threadTs: undefined, fromCache: false, error };
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
    }): Promise<string | undefined> => {
      const { threadTs, error } = await lookupThreadTs(request);
      if (error !== undefined && shouldLogVerbose()) {
        logVerbose(
          `slack: failed to resolve thread_ts for system event channel=${request.channelId} ts=${request.messageTs}: ${formatSlackError(error)}`,
        );
      }
      if (!threadTs) {
        return undefined;
      }
      // Slack reports thread_ts on messages that are not replies (an assistant DM root
      // carries thread_ts === ts). The inbound path decides reply identity through the
      // threading owner, so a system event must not key a lane no inbound turn writes.
      return resolveSlackThreadContext({
        message: {
          type: "message",
          channel: request.channelId,
          ts: request.messageTs,
          thread_ts: threadTs,
        },
        replyToMode: "off",
      }).replyToId;
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
