import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../../auto-reply/tokens.js";
import { resolveAssistantMessagePhase } from "../../shared/chat-message-content.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";

type PayloadVisibilityOptions = {
  includeErrorPayloads?: boolean;
  includeReasoningPayloads?: boolean;
  includeSilentReplyPayloads?: boolean;
  requireTerminalContent?: boolean;
};

export function collectMediaUrlsFromRecord(
  record: Record<string, unknown>,
  output: Set<string>,
  // Payloads arrive as in-process `unknown` objects, so a malformed
  // self-referential `attachments` chain must not recurse indefinitely.
  seen = new WeakSet<object>(),
) {
  if (seen.has(record)) {
    return;
  }
  seen.add(record);
  for (const key of ["mediaUrl", "mediaUrls", "path", "url", "filePath"] as const) {
    for (const value of normalizeSingleOrTrimmedStringList(record[key])) {
      output.add(value);
    }
  }
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      const nested = asOptionalRecord(attachment);
      if (nested) {
        collectMediaUrlsFromRecord(nested, output, seen);
      }
    }
  }
}

function hasVisibleAttachmentReference(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const urls = new Set<string>();
  collectMediaUrlsFromRecord({ attachments: value }, urls);
  return urls.size > 0;
}

/** Applies the shared exact or payload-aware silent-reply contract. */
export function isSilentAgentReplyText(
  value: unknown,
  mode: "exact" | "payload" = "exact",
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return mode === "payload"
    ? isSilentReplyPayloadText(value, SILENT_REPLY_TOKEN)
    : isSilentReplyText(value, SILENT_REPLY_TOKEN);
}

/** Returns whether payload metadata contains user-visible content. */
export function hasVisibleAgentPayload(
  result: { payloads?: unknown },
  options: PayloadVisibilityOptions = {},
): boolean {
  return (
    Array.isArray(result.payloads) &&
    result.payloads.some((payload) => {
      if (!payload || typeof payload !== "object") {
        return false;
      }
      const record = payload as ReplyPayload & { visible?: unknown };
      if (
        options.requireTerminalContent &&
        (record.visible === false || !isReplyPayloadTerminalContent(record))
      ) {
        return false;
      }
      if (options.includeErrorPayloads === false && record.isError === true) {
        return false;
      }
      if (options.includeReasoningPayloads === false && record.isReasoning === true) {
        return false;
      }
      const visibleText =
        hasNonEmptyString(record.text) &&
        (options.includeSilentReplyPayloads !== false ||
          !isSilentAgentReplyText(record.text, "payload"));
      return Boolean(
        visibleText ||
        hasNonEmptyString(record.mediaUrl) ||
        hasNonEmptyStringArray(record.mediaUrls) ||
        hasVisibleAttachmentReference(record.attachments) ||
        record.visible === true ||
        record.presentation ||
        record.interactive ||
        record.channelData,
      );
    })
  );
}

/** Honors recorded visibility before deriving it from the payload's visible content. */
export function hasExplicitlyVisibleAgentPayload(payload: unknown): boolean {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "visible" in payload) {
    if (typeof payload.visible === "boolean") {
      return payload.visible;
    }
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    { includeErrorPayloads: false, includeReasoningPayloads: false },
  );
}

/** Returns whether a payload intentionally contains only the silent-reply marker. */
export function hasIntentionalSilentAgentPayload(result: { payloads?: unknown }): boolean {
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  return payloads.some((payload) => {
    const record = asOptionalRecord(payload);
    if (!record) {
      return false;
    }
    return (
      isSilentAgentReplyText(record.text, "payload") &&
      !hasVisibleAgentPayload({ payloads: [{ ...record, text: undefined }] })
    );
  });
}

/** Reads a transcript message role without trusting its boundary shape. */
export function getTranscriptMessageRole(message: unknown): string | undefined {
  const role = asOptionalObjectRecord(message)?.role;
  return typeof role === "string" ? role : undefined;
}

/** Reads a committed final source-reply mirror from a transcript message. */
export function readTerminalSourceReplyDeliveryMirror(
  message: unknown,
): { sourceTurnId: string; toolCallId?: string } | undefined {
  const delivery = asOptionalObjectRecord(asOptionalObjectRecord(message)?.openclawDeliveryMirror);
  if (!delivery) {
    return undefined;
  }
  const sourceTurnId =
    typeof delivery.sourceTurnId === "string" ? delivery.sourceTurnId.trim() : "";
  if (delivery.kind !== "message-tool-source-reply" || delivery.final !== true || !sourceTurnId) {
    return undefined;
  }
  const toolCallId = typeof delivery.toolCallId === "string" ? delivery.toolCallId.trim() : "";
  return { sourceTurnId, ...(toolCallId ? { toolCallId } : {}) };
}

/** System and malformed records do not constitute a resumable transcript tail. */
export function isMeaningfulTranscriptMessage(message: unknown): boolean {
  const role = getTranscriptMessageRole(message);
  return Boolean(role && role !== "system");
}

/** Recognizes persisted progress without mistaking an ordinary assistant answer for completion. */
export function isIntermediateAssistantTranscriptMessage(message: unknown): boolean {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant") {
    return false;
  }
  if (record.stopReason !== undefined && record.stopReason !== "stop") {
    return false;
  }
  if (hasNonEmptyString(asOptionalRecord(record.openclawAsyncDelivery)?.itemId)) {
    return true;
  }
  const phase = resolveAssistantMessagePhase(message);
  if (phase !== undefined) {
    return phase === "commentary";
  }
  const fallback = asOptionalRecord(record.openclawStreamFallback);
  // Keyed segments are durable progress items; unkeyed/current fallbacks can
  // become the final answer and must never bypass restart completion checks.
  return fallback?.source === "segment" && hasNonEmptyString(fallback.itemId);
}

/** Returns whether a stopped assistant turn contains only reasoning and a silent marker. */
export function isTerminalSilentAssistantMessage(message: unknown): boolean {
  const messageRecord = asOptionalObjectRecord(message);
  if (
    messageRecord?.role !== "assistant" ||
    typeof messageRecord.stopReason !== "string" ||
    messageRecord.stopReason.trim() !== "stop"
  ) {
    return false;
  }
  const content = messageRecord.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; text?: unknown };
    const type = typeof record.type === "string" ? record.type.trim() : undefined;
    if (type === "thinking") {
      continue;
    }
    if (type !== "text") {
      return false;
    }
    if (typeof record.text === "string" && record.text.trim()) {
      textParts.push(record.text.trim());
    }
  }
  return isSilentAgentReplyText(textParts.join("\n"), "payload");
}
