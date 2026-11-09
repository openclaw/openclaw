import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkTextForOutbound,
  convertMarkdownTables,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import type { CoreConfig } from "./types.js";

export function sanitizeIrcAssistantText(text: string): string {
  return sanitizeForPlainText(sanitizeAssistantVisibleText(text));
}

/**
 * IRC has no rich text, so direct sends and inbound replies render Markdown to
 * plain text with this one helper. Render the complete source before splitting:
 * fragment parsing loses code, link, and table context.
 */
export function renderIrcPlainText(
  text: string,
  params: { cfg: CoreConfig; accountId?: string },
): string {
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "irc",
    accountId: params.accountId,
  });
  return stripMarkdown(convertMarkdownTables(text.trim(), tableMode));
}

export const ircOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 350,
  // IRC's plain-text pass does not remove assistant scaffolding. Run the
  // canonical delivery sanitizer first so internal tool traces are dropped
  // before channel formatting.
  sanitizeText: ({ text }: { text: string }) => sanitizeIrcAssistantText(text),
};
