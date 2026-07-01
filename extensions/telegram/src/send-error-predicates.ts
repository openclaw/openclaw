// Telegram API rejection predicates shared by durable and streaming send funnels.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

const RICH_ENTITY_INVALID_RE =
  /RICH_MESSAGE_(?:EMAIL|URL|MENTION|HASHTAG|CASHTAG|BOT_COMMAND|PHONE|BANK_CARD)_INVALID/i;
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

export function isTelegramRichEntityInvalidError(err: unknown): boolean {
  return RICH_ENTITY_INVALID_RE.test(formatErrorMessage(err));
}

export function isTelegramHtmlParseError(err: unknown): boolean {
  return PARSE_ERR_RE.test(formatErrorMessage(err));
}
