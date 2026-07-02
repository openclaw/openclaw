import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";

export type TelegramPromptContextMessageForDedupe = {
  body?: unknown;
  timestamp_ms?: unknown;
};

export function resolvePromptContextTextDedupeKey(
  message: TelegramPromptContextMessageForDedupe,
): string | undefined {
  if (typeof message.body !== "string" || !message.body.trim()) {
    return undefined;
  }
  if (typeof message.timestamp_ms !== "number" || !Number.isFinite(message.timestamp_ms)) {
    return undefined;
  }
  const visibleBody = stripInlineDirectiveTagsForDelivery(message.body).text.trim();
  return visibleBody ? `${message.timestamp_ms}:${visibleBody}` : undefined;
}
