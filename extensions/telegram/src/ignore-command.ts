import type { Message } from "grammy/types";

const IGNORE_COMMAND_RE = /^\/ignore(?:@([a-z0-9_]+))?$/i;

type TelegramIgnoreDisposition = "exclude" | "help" | "keep";

export const TELEGRAM_IGNORE_HELP_TEXT =
  "Use /ignore <message> to keep this text message out of OpenClaw context. Replies or edits may include it later.";

export function resolveTelegramIgnoreDisposition(
  msg: Pick<Message, "entities" | "forward_origin" | "from" | "text">,
  botUsername?: string,
): TelegramIgnoreDisposition {
  if (msg.from?.is_bot !== false || msg.forward_origin || !msg.text) {
    return "keep";
  }
  const command = msg.entities?.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!command) {
    return "keep";
  }
  const match = IGNORE_COMMAND_RE.exec(msg.text.slice(0, command.length));
  if (!match) {
    return "keep";
  }
  const target = match[1]?.toLowerCase();
  if (target && target !== botUsername?.trim().toLowerCase()) {
    return "keep";
  }
  return msg.text.slice(command.length).trim() ? "exclude" : "help";
}
