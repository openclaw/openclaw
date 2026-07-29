import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
} from "openclaw/plugin-sdk/text-chunking";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { sanitizeOutboundText } from "./monitor/sanitize-outbound.js";

/** Applies the channel-level sanitizer before iMessage-specific wire transforms. */
export function sanitizeIMessageOutboundText(text: string): string {
  return sanitizeForPlainText(sanitizeOutboundText(text), { style: "markdown" });
}

/**
 * Applies the final text transforms shared by live sends and unknown-send
 * reconciliation. Keeping this in one place prevents history matching from
 * drifting away from the text that imsg actually receives.
 */
export function prepareIMessageOutboundText(params: {
  cfg: OpenClawConfig;
  accountId: string;
  text: string;
}) {
  let message = params.text;
  if (message.trim()) {
    const tableMode = resolveMarkdownTableMode({
      cfg: params.cfg,
      channel: "imessage",
      accountId: params.accountId,
    });
    message = convertMarkdownTables(message, tableMode);
  }
  message = stripInlineDirectiveTagsForDelivery(message).text;
  return message.trim() ? extractMarkdownFormatRuns(message) : { text: message, ranges: [] };
}
