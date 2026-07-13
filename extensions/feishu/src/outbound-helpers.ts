// Feishu outbound helper decisions.
import path from "node:path";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type FeishuReplyMode =
  | { normalizedReplyToId: string; replyToMessageId: string; replyInThread: false }
  | { normalizedReplyToId: undefined; replyToMessageId: string; replyInThread: true }
  | { normalizedReplyToId: undefined; replyToMessageId: undefined; replyInThread: false };

export function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw || /\s/.test(raw) || /^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt || !path.isAbsolute(raw)) {
    return null;
  }
  try {
    return statRegularFileSync(raw).missing ? null : raw;
  } catch {
    return null;
  }
}

export function resolveFeishuReplyMode(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuReplyMode {
  const replyToMessageId = params.replyToId?.trim();
  if (replyToMessageId) {
    return { normalizedReplyToId: replyToMessageId, replyToMessageId, replyInThread: false };
  }
  const threadId = params.threadId == null ? undefined : String(params.threadId).trim();
  return threadId
    ? { normalizedReplyToId: undefined, replyToMessageId: threadId, replyInThread: true }
    : {
        normalizedReplyToId: undefined,
        replyToMessageId: undefined,
        replyInThread: false,
      };
}
