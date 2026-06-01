import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { stripPlainTextToolCallBlocks } from "openclaw/plugin-sdk/tool-payload";

function hasNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
  );
}

function hasInteractiveOrPresentationBlocks(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.trim().length > 0) {
    return true;
  }
  return Array.isArray(record.blocks) && record.blocks.length > 0;
}

function hasNonTextReplyPayloadContent(payload: ReplyPayload): boolean {
  return (
    payload.audioAsVoice === true ||
    hasNonEmptyRecord(payload.channelData) ||
    hasInteractiveOrPresentationBlocks(payload.interactive) ||
    hasInteractiveOrPresentationBlocks(payload.presentation)
  );
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export function sanitizeDiscordFrontChannelText(text: string): string {
  const withoutToolCallBlocks = stripPlainTextToolCallBlocks(text);
  const withoutAssistantScaffolding = sanitizeAssistantVisibleText(withoutToolCallBlocks);
  const withoutResidualToolCallBlocks = stripPlainTextToolCallBlocks(withoutAssistantScaffolding);
  return collapseExcessBlankLines(withoutResidualToolCallBlocks).trim();
}

export function sanitizeDiscordFrontChannelReplyPayloads(
  payloads: readonly ReplyPayload[],
  options: { kind?: "tool" | "block" | "final" } = {},
): ReplyPayload[] {
  const preserveVerboseToolProgress = options.kind === "tool";
  const safePayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    const safeText =
      typeof payload.text === "string"
        ? preserveVerboseToolProgress
          ? collapseExcessBlankLines(payload.text).trim()
          : sanitizeDiscordFrontChannelText(payload.text)
        : payload.text;
    const nextPayload =
      safeText === payload.text
        ? payload
        : ({ ...payload, text: safeText || undefined } as ReplyPayload);
    const nextParts = resolveSendableOutboundReplyParts(nextPayload);
    if (!nextParts.hasContent && !hasNonTextReplyPayloadContent(nextPayload)) {
      continue;
    }
    safePayloads.push(nextPayload);
  }
  return safePayloads;
}
