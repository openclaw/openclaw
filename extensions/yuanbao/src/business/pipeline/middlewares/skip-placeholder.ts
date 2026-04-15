/**
 * Middleware: skip placeholder and empty messages
 *
 * 整段为单对方括号占位（如 [image]）且无Media时跳过；
 * [EMOJI] / [EMOJI: …] 视为表情语义，不跳过。
 */

import type { MiddlewareDescriptor } from "../types.js";

/**
 * 是否应跳过处理：整段为单对方括号占位（如 `[image]`）、且无Media；
 * `[EMOJI]` / `[EMOJI: …]` 视为表情语义，不跳过。
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

    // 群聊：空消息且无Media且非 @bot 时跳过
    if (isGroup) {
      if (!rawBody.trim() && medias.length === 0 && !isAtBot) {
        ctx.log.warn("[skip-placeholder] group message body empty, skipping");
        return;
      }
    } else {
      // C2C：空消息跳过
      if (!rawBody.trim()) {
        ctx.log.warn("[skip-placeholder] message body empty, skipping");
        return;
      }
    }

    // 占位符消息跳过
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
