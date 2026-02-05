import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";
import { normalizeEmojiName } from "./normalize.js";

export async function addZulipReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  emojiName: string;
  abortSignal?: AbortSignal;
}): Promise<ZulipApiSuccess> {
  const emojiName = normalizeEmojiName(params.emojiName);
  return await zulipRequest<ZulipApiSuccess>({
    auth: params.auth,
    method: "POST",
    path: `/api/v1/messages/${params.messageId}/reactions`,
    form: {
      emoji_name: emojiName,
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
  return await zulipRequest<ZulipApiSuccess>({
    auth: params.auth,
    method: "DELETE",
    path: `/api/v1/messages/${params.messageId}/reactions`,
    form: {
      emoji_name: emojiName,
    },
    abortSignal: params.abortSignal,
  });
}
