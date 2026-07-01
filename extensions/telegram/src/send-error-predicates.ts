// Telegram API rejection predicates shared by durable and streaming send funnels.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

const RICH_ENTITY_INVALID_RE =
  /RICH_MESSAGE_(?:EMAIL|URL|MENTION|HASHTAG|CASHTAG|BOT_COMMAND|PHONE|BANK_CARD)_INVALID/i;

export function isTelegramRichEntityInvalidError(err: unknown): boolean {
  return RICH_ENTITY_INVALID_RE.test(formatErrorMessage(err));
}
