import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  convertMarkdownTables,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";

function mapZalouserReplyText(
  payload: OutboundReplyPayload,
  transform: (text: string) => string,
): OutboundReplyPayload {
  return payload.text === undefined ? payload : { ...payload, text: transform(payload.text) };
}

export function prepareZalouserReplyTables(
  payload: OutboundReplyPayload,
  tableMode: MarkdownTableMode,
): OutboundReplyPayload {
  return mapZalouserReplyText(payload, (text) => convertMarkdownTables(text, tableMode));
}

export function sanitizeZalouserReplyPayload(payload: OutboundReplyPayload): OutboundReplyPayload {
  return mapZalouserReplyText(payload, sanitizeAssistantVisibleText);
}
