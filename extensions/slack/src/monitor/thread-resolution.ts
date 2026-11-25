import type { WebClient as SlackWebClient } from "@slack/web-api";
import { createStaleWhileRevalidateCache } from "openclaw/plugin-sdk/collection-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString as normalizeThreadTs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";
import { isTransientSlackApiError } from "./transient-api-error.js";

const DEFAULT_THREAD_TS_CACHE_TTL_MS = 60_000;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;

const markAmbiguousThreadReply = (message: SlackMessageEvent): SlackMessageEvent => ({
  ...message,
  _ambiguousThreadReply: true,
});

export function createSlackThreadTsResolver(params: { client: SlackWebClient }) {
  const cache = createStaleWhileRevalidateCache<string | null>({
    maxEntries: DEFAULT_THREAD_TS_CACHE_MAX,
    // Preserve caller-owned admission; this cache must not reject an admitted turn.
    maxPending: Number.POSITIVE_INFINITY,
    ttlMs: DEFAULT_THREAD_TS_CACHE_TTL_MS,
  });

  return {
    resolve: async (request: {
      message: SlackMessageEvent;
      source: "message" | "app_mention";
      turnAdoptionLifecycle?: SlackIngressTurnLifecycle;
    }): Promise<SlackMessageEvent> => {
      const { message } = request;
      const messageTs = message.ts;
      if (!message.parent_user_id || message.thread_ts || !messageTs) {
        return message;
      }

      const cacheKey = `${message.channel}:${messageTs}`;
      let resolved: string | null;
      try {
        ({ value: resolved } = await cache.read(
          cacheKey,
          async () => {
            if (shouldLogVerbose()) {
              logVerbose(
                `slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`,
              );
            }
            try {
              const response = await params.client.conversations.history({
                channel: message.channel,
                latest: messageTs,
                oldest: messageTs,
                inclusive: true,
                limit: 1,
              });
              const historyMessage =
                response.messages?.find((entry) => entry.ts === messageTs) ??
                response.messages?.[0];
              return normalizeThreadTs(historyMessage?.thread_ts) ?? null;
            } catch (err) {
              if (shouldLogVerbose()) {
                logVerbose(
                  `slack inbound: failed to resolve thread_ts via conversations.history for channel=${message.channel} ts=${message.ts}: ${formatSlackError(err)}`,
                );
              }
              if (isTransientSlackApiError(err)) {
                throw err;
              }
              return null;
            }
          },
          { allowStale: false },
        ));
      } catch (err) {
        if (request.turnAdoptionLifecycle) {
          // The already-acknowledged durable ingress owner retries without dropping the turn.
          throw err;
        }
        return markAmbiguousThreadReply(message);
      }
      if (resolved) {
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
