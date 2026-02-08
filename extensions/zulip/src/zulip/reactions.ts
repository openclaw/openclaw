import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { zulipRequestWithRetry } from "./client.js";
import { normalizeEmojiName } from "./normalize.js";

export async function addZulipReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  emojiName: string;
  abortSignal?: AbortSignal;
}): Promise<ZulipApiSuccess> {
  const emojiName = normalizeEmojiName(params.emojiName);
  return await zulipRequestWithRetry<ZulipApiSuccess>({
    auth: params.auth,
    method: "POST",
    path: `/api/v1/messages/${params.messageId}/reactions`,
    form: {
      emoji_name: emojiName,
    },
    retry: {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
    },
    abortSignal: params.abortSignal,
  });
}

export async function removeZulipReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  emojiName: string;
  abortSignal?: AbortSignal;
}): Promise<ZulipApiSuccess> {
  const emojiName = normalizeEmojiName(params.emojiName);
  return await zulipRequestWithRetry<ZulipApiSuccess>({
    auth: params.auth,
    method: "DELETE",
    path: `/api/v1/messages/${params.messageId}/reactions`,
    // Zulip's DELETE endpoints are not guaranteed to accept request bodies.
    // Send identifiers as query params so reactions reliably clear.
    query: {
      emoji_name: emojiName,
    },
    retry: {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
    },
    abortSignal: params.abortSignal,
  });
}
