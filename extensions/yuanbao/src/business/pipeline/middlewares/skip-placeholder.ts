/**
 * Middleware: skip placeholder and empty messages.
 *
 * Skips single bracket placeholders (e.g. [image]) without media;
 * [EMOJI] / [EMOJI: ...] are treated as emoji semantics and not skipped.
 */

import type { MiddlewareDescriptor } from "../types.js";

/**
 * Whether to skip: single bracket placeholder (e.g. `[image]`) without media;
 * `[EMOJI]` / `[EMOJI: ...]` are treated as emoji semantics and not skipped.
 */
function isSkippableBracketPlaceholder(rawBody: string, mediaCount: number): boolean {
  if (mediaCount > 0) {
    return false;
  }
  const t = rawBody.trim();
  if (!/^\[.+\]$/.test(t)) {
    return false;
  }
  if (/^\[EMOJI/i.test(t)) {
    return false;
  }
  return true;
}

export const skipPlaceholder: MiddlewareDescriptor = {
  name: "skip-placeholder",
  handler: async (ctx, next) => {
    const { rawBody, medias, isAtBot, isGroup } = ctx;

    // Group chat: skip empty message with no media and not @bot
    if (isGroup) {
      if (!rawBody.trim() && medias.length === 0 && !isAtBot) {
        ctx.log.warn("[skip-placeholder] group message body empty, skipping");
        return;
      }
    } else {
      // C2C: skip empty message
      if (!rawBody.trim()) {
        ctx.log.warn("[skip-placeholder] message body empty, skipping");
        return;
      }
    }

    // Skip placeholder message
    if (isSkippableBracketPlaceholder(rawBody, medias.length)) {
      ctx.log.debug("[skip-placeholder] placeholder message, skipping", {
        user_input: rawBody,
        fromAccount: ctx.fromAccount,
      });
      return;
    }

    await next();
  },
};
