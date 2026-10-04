import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";

export function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = asOptionalObjectRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Retain memory's input facts, not tool results, attachments, or provider replay payloads. */
export function projectSessionEntryRecord(value: unknown): unknown {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const message = record.type === "message" ? asOptionalRecord(record.message) : undefined;
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  const provenance = asOptionalRecord(message?.provenance);
  const data = asOptionalRecord(record.data);
  const timestamp = (candidate: unknown) =>
    typeof candidate === "string" || typeof candidate === "number" ? candidate : undefined;
  return {
    type: readStringValue(record.type),
    id: readStringValue(record.id),
    firstKeptEntryId:
      record.firstKeptEntryId === undefined
        ? undefined
        : (readStringValue(record.firstKeptEntryId) ?? null),
    customType: readStringValue(record.customType),
    runId: readStringValue(record.runId),
    sessionKey: readStringValue(record.sessionKey),
    data: { runId: readStringValue(data?.runId), sessionKey: readStringValue(data?.sessionKey) },
    timestamp: timestamp(record.timestamp),
    message: message
      ? {
          role: readStringValue(message.role),
          timestamp: timestamp(message.timestamp),
          content:
            message.role === "user" || message.role === "assistant"
              ? collectRawSessionText(message.content)
              : null,
          provenance: {
            kind: readStringValue(provenance?.kind),
            sourceTool: readStringValue(provenance?.sourceTool),
          },
          __openclaw: {
            runId: readStringValue(metadata?.runId),
            senderIsOwner: metadata?.senderIsOwner === true,
            turnTainted: metadata?.turnTainted === true,
          },
        }
      : undefined,
  };
}

// Keep the historical one-line-per-message export shape for normal turns, but
// wrap pathological long messages so downstream indexers never ingest a single
// toxic line. Wrapped continuation lines still map back to the same JSONL line.
// This limit applies to content only; the role label adds up to 11 chars.
const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;

function splitLongSessionLine(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= SESSION_EXPORT_CONTENT_WRAP_CHARS) {
    return [normalized];
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    if (remaining <= SESSION_EXPORT_CONTENT_WRAP_CHARS) {
      segments.push(normalized.slice(cursor).trim());
      break;
    }

    const limit = cursor + SESSION_EXPORT_CONTENT_WRAP_CHARS;
    let splitAt = limit;
    for (let index = limit; index > cursor; index -= 1) {
      if (normalized[index] === " ") {
        splitAt = index;
        break;
      }
    }
    splitAt = avoidTrailingHighSurrogateBreak(normalized, cursor, splitAt);
    segments.push(normalized.slice(cursor, splitAt).trim());
    cursor = splitAt;
    while (cursor < normalized.length && normalized[cursor] === " ") {
      cursor += 1;
    }
  }

  return segments.filter(Boolean);
}

export function renderSessionExportLines(label: string, text: string): string[] {
  return splitLongSessionLine(text).map((segment) => `${label}: ${segment}`);
}
