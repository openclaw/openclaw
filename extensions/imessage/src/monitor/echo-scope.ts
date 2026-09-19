import type { SentMessageCache } from "./echo-cache.js";

/**
 * Strict reflected-reply probe.
 *
 * Direct replies are dispatched with the provider's exact chat-id target and persisted
 * under that scope, so the probe has to consult every scope the conversation can be
 * keyed by. Scopes are probed in order and short-circuit on the first hit, which keeps
 * the common `imessage:<handle>` case to a single cache read.
 */
export async function hasReflectedReplyEcho(params: {
  echoCache: {
    has: (...args: Parameters<SentMessageCache["has"]>) => boolean | Promise<boolean>;
  };
  scopes: readonly string[];
  text: string;
  messageId: string;
}): Promise<boolean> {
  for (const scope of params.scopes) {
    if (
      await params.echoCache.has(
        scope,
        { text: params.text, messageId: params.messageId },
        { requireMessageIdTextMatch: true },
      )
    ) {
      return true;
    }
  }
  return false;
}

