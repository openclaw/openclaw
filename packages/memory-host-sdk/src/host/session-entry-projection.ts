import { createHash, type Hash } from "node:crypto";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import type { SessionResetRecallCutoff } from "./session-reset-recall.js";
import type { MemoryEntryProvenance } from "./types.js";

/** One exported message: all of its wrapped lines share these facts. */
type SessionEntryLineRun = {
  sourceLine: number;
  timestampMs: number;
  provenance: MemoryEntryProvenance;
  lines: number;
};

const HASH_FLUSH_CHARS = 64 * 1024;

/**
 * Computes the persisted entry hash while lines stream in, without retaining the rendered
 * content: sha256 over the content, then "\n"-separated comma-joined line map and timestamps,
 * the JSON line provenance and the JSON reset recall cutoff. Line facts are retained run-length
 * encoded per message, because that format places them after the complete content.
 */
export function createSessionEntryHasher(prefixLineCount?: number) {
  let content = createHash("sha256");
  let runs: SessionEntryLineRun[] = [];
  let lineCount = 0;
  let prefix: Hash | undefined;
  const capturePrefix = () => {
    if (prefixLineCount === lineCount) {
      prefix = content.copy();
    }
  };
  capturePrefix();
  const digest = (
    hash: Hash,
    limit: number,
    resetRecallCutoff: SessionResetRecallCutoff,
  ): string => {
    let buffer = "";
    const write = (text: string) => {
      buffer += text;
      if (buffer.length >= HASH_FLUSH_CHARS) {
        hash.update(buffer);
        buffer = "";
      }
    };
    const writeFacts = (encode: (run: SessionEntryLineRun) => string, separator: string): void => {
      let remaining = limit;
      let first = true;
      for (const run of runs) {
        if (remaining <= 0) {
          break;
        }
        const value = encode(run);
        const count = Math.min(run.lines, remaining);
        for (let index = 0; index < count; index++) {
          write(first ? value : separator + value);
          first = false;
        }
        remaining -= count;
      }
    };
    write("\n");
    writeFacts((run) => String(run.sourceLine), ",");
    write("\n");
    writeFacts((run) => String(run.timestampMs), ",");
    write("\n[");
    // JSON.stringify(array) joins each element's own encoding with commas.
    writeFacts((run) => JSON.stringify(run.provenance), ",");
    write("]\n");
    write(JSON.stringify(resetRecallCutoff));
    hash.update(buffer);
    return hash.digest("hex");
  };
  return {
    get lineCount() {
      return lineCount;
    },
    /** Appends one message's rendered lines. */
    append(lines: readonly string[], facts: Omit<SessionEntryLineRun, "lines">): void {
      for (const line of lines) {
        content.update(lineCount === 0 ? line : `\n${line}`);
        lineCount++;
        capturePrefix();
      }
      if (lines.length > 0) {
        runs.push({ ...facts, lines: lines.length });
      }
    },
    /** Discards every appended line. */
    reset(): void {
      content = createHash("sha256");
      runs = [];
      lineCount = 0;
      prefix = undefined;
      capturePrefix();
    },
    finish(resetRecallCutoff: SessionResetRecallCutoff): { hash: string; prefixHash?: string } {
      const prefixHash =
        prefix && prefixLineCount !== undefined
          ? digest(prefix, prefixLineCount, resetRecallCutoff)
          : undefined;
      return {
        hash: digest(content, lineCount, resetRecallCutoff),
        ...(prefixHash ? { prefixHash } : {}),
      };
    },
  };
}

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
export function projectSessionEntryRecord(
  value: unknown,
  prepareTranscriptText: (message: unknown, text: string | undefined) => string | undefined,
): unknown {
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
          display:
            message.display === false
              ? false
              : message.role === "assistant" || message.display === true
                ? true
                : undefined,
          timestamp: timestamp(message.timestamp),
          content:
            message.role === "user" || message.role === "assistant"
              ? (prepareTranscriptText(
                  message,
                  collectRawSessionText(message.content) ?? undefined,
                ) ?? null)
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

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export function parseSessionTimestampMs(
  record: { timestamp?: unknown },
  message: { timestamp?: unknown },
): number {
  const candidates = [message.timestamp, record.timestamp];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 0 && value < 1e11 ? value * 1000 : value;
      if (Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_TIMESTAMP_MS) {
        return Math.floor(ms);
      }
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return 0;
}
