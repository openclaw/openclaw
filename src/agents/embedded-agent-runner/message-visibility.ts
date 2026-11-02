import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  hasReplyPayloadSpeechContent,
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { resolveAssistantMessagePhase } from "../../shared/chat-message-content.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";

function collectMediaUrlsFromRecord(
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

export function hasVisibleAgentPayload(
  result: { payloads?: unknown },
  options: {
    includeErrorPayloads?: boolean;
    includeReasoningPayloads?: boolean;
    requireTerminalContent?: boolean;
  } = {},
): boolean {
  return (
    Array.isArray(result.payloads) &&
    result.payloads.some((payload) => {
      if (!payload || typeof payload !== "object") {
        return false;
      }
      const record = payload as ReplyPayload & { visible?: unknown };
      if (
        (options.requireTerminalContent &&
          (record.visible === false || !isReplyPayloadTerminalContent(record))) ||
        (options.includeErrorPayloads === false && record.isError === true) ||
        (options.includeReasoningPayloads === false && record.isReasoning === true)
      ) {
        return false;
      }
      const visibleText = hasNonEmptyString(record.text);
      return Boolean(
        visibleText ||
        hasReplyPayloadSpeechContent(record) ||
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

export function getTranscriptMessageRole(message: unknown): string | undefined {
  const role = asOptionalObjectRecord(message)?.role;
  return typeof role === "string" ? role : undefined;
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
