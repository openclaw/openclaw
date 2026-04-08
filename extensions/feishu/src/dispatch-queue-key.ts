import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";

/**
 * Resolve the serial-queue key for a Feishu message event.
 *
 * Abort/interrupt commands (`/stop`, `stop`, `halt`, …) are routed to a
 * dedicated `${chatId}:control` queue so they are never blocked behind an
 * active agent run.  This mirrors the Telegram channel's
 * `getTelegramSequentialKey` pattern (see
 * `extensions/telegram/src/sequential-key.ts`).
 *
 * Normal messages — including non-interrupt slash commands like `/model` or
 * `/send` — use the plain `chatId` key (per-chat serial) to preserve
 * ordering guarantees with active runs.
 */
export function resolveFeishuDispatchQueueKey(params: {
  chatId: string;
  messageText: string;
}): string {
  const { chatId, messageText } = params;
  const trimmed = messageText.trim();
  if (trimmed && isAbortRequestText(trimmed)) {
    return `${chatId}:control`;
  }
  return chatId;
}
