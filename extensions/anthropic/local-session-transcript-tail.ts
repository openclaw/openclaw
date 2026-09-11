// Forward tailer over one Claude Code JSONL transcript for the live local
// session source. Claude appends one JSON record per line while a session is
// interactive; this module turns message records into wire records and keeps
// a resumable byte offset so live tailing never re-emits or skips a record.
import fs from "node:fs/promises";
import {
  clipLocalSessionRecordText,
  LOCAL_SESSION_BOOTSTRAP_MAX_BYTES,
  LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS,
  type LocalSessionRecord,
} from "openclaw/plugin-sdk/local-session-source";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectTranscriptText } from "./session-catalog-transcript.js";

const READ_CHUNK_BYTES = 256 * 1024;
/** Matches the catalog transcript reader: larger transcripts are not projected live. */
const MAX_TAILED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Tool inputs are JSON; keep the model-visible call bounded well under the record ceiling. */
const TOOL_INPUT_MAX_CHARS = 8 * 1024;
/** Channel deliveries land in the transcript as `<channel source="openclaw" … openclaw_input_id="…">`. */
const CHANNEL_INPUT_ID_PATTERN =
  /<channel\b[^>]*\bsource="openclaw"[^>]*\bopenclaw_input_id="([^"]+)"/;

export type ClaudeTranscriptRecord = LocalSessionRecord & {
  /** Set on the assistant record that ended the model turn (Claude's `stop_reason`). */
  endsTurn?: boolean;
};

type ToolUseBlock = { name: string; input: unknown; id?: string };

function readToolUse(content: unknown): ToolUseBlock | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
      return {
        name: block.name,
        input: block.input,
        ...(typeof block.id === "string" ? { id: block.id } : {}),
      };
    }
  }
  return undefined;
}

function isToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isRecord(block) && block.type === "tool_result")
  );
}

function isReasoning(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isRecord(block) && block.type === "thinking")
  );
}

function formatToolInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input ?? {}, null, 1) ?? "{}";
  } catch {
    json = "{}";
  }
  return json.length > TOOL_INPUT_MAX_CHARS ? `${json.slice(0, TOOL_INPUT_MAX_CHARS)}\n…` : json;
}

function transcriptText(content: unknown): string {
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  return [...new Set(fragments)].join("\n\n");
}

/**
 * Convert one transcript line into a wire record, or undefined for lines the
 * team projection does not carry (metadata rows, sidechains, meta prompts).
 * Callers assign `seq`; the conversion itself is pure so a rescan reproduces
 * the same records for the same bytes.
 */
function convertClaudeTranscriptLine(
  line: Buffer,
  seq: number,
): ClaudeTranscriptRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.isSidechain === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const id = readBoundedString(raw.uuid, 256);
  const ts = parseDateFirstTimestampMs(raw.timestamp);
  if (!id || ts === undefined) {
    return undefined;
  }
  const content = raw.message.content;
  const text = transcriptText(content);
  // Channel deliveries may be flagged as meta prompts; they are the one meta row
  // the team must see because it echoes their own input back with its id.
  const clientId = role === "user" ? CHANNEL_INPUT_ID_PATTERN.exec(text)?.[1] : undefined;
  if (raw.isMeta === true && !clientId) {
    return undefined;
  }
  const base = { id, seq, ts };
  if (role === "user") {
    if (isToolResult(content)) {
      return { ...base, kind: "toolResult", ...clipLocalSessionRecordText(text) };
    }
    if (!text) {
      return undefined;
    }
    return {
      ...base,
      kind: "user",
      ...clipLocalSessionRecordText(text),
      ...(clientId ? { clientId } : {}),
    };
  }
  const toolUse = readToolUse(content);
  const stopReason = raw.message.stop_reason;
  const endsTurn = stopReason === "end_turn" || stopReason === "stop_sequence";
  if (toolUse) {
    return {
      ...base,
      kind: "toolCall",
      toolName: toolUse.name.slice(0, 256),
      ...clipLocalSessionRecordText(formatToolInput(toolUse.input)),
    };
  }
  if (isReasoning(content)) {
    return text ? { ...base, kind: "reasoning", ...clipLocalSessionRecordText(text) } : undefined;
  }
  if (!text) {
    return undefined;
  }
  return {
    ...base,
    kind: "assistant",
    ...clipLocalSessionRecordText(text),
    ...(endsTurn ? { endsTurn } : {}),
  };
}

/** Drop `endsTurn` before a record crosses the strict wire schema. */
export function toWireRecord(record: ClaudeTranscriptRecord): LocalSessionRecord {
  const { endsTurn: _endsTurn, ...wire } = record;
  return wire;
}

export type ClaudeTranscriptTailer = {
  readonly filePath: string;
  /** Seq of the last record returned by `readNext`/`bootstrap`; 0 before any read. */
  readonly lastSeq: number;
  /**
   * Scan the whole file once and return the newest bootstrap window whose seq is
   * above `afterSeq` (a Gateway resume cursor). `earliestSeq` is the first seq
   * the window kept; records before it exist but were not replayed.
   */
  bootstrap(afterSeq: number): Promise<{
    records: ClaudeTranscriptRecord[];
    earliestSeq?: number;
    oversized: boolean;
  }>;
  /** Return records appended since the previous read; empty when nothing complete landed. */
  readNext(): Promise<{ records: ClaudeTranscriptRecord[]; missing: boolean }>;
};

async function statOrUndefined(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Create a tailer. Invariants:
 * - The checkpoint (`offset`) always sits right after the last complete line;
 *   a trailing partial line is re-read on the next pass, never parsed early,
 *   because Claude writes records in more than one syscall.
 * - `seq` is the 1-based index among emitted records in file order. A rescan of
 *   the same bytes reproduces the same seqs, so Gateway cursors survive node
 *   restarts without any local state.
 * - A size shrink or inode change means the file was rewritten; rescan from the
 *   start and only surface records past the last seq already handed out.
 */
export function createClaudeTranscriptTailer(filePath: string): ClaudeTranscriptTailer {
  let offset = 0;
  let seq = 0;
  let ino: number | undefined;
  let lastSeq = 0;

  const scanFrom = async (
    start: number,
    startSeq: number,
    onRecord: (record: ClaudeTranscriptRecord) => void,
  ): Promise<{ offset: number; seq: number; ino: number } | undefined> => {
    const handle = await fs.open(filePath, "r").catch(() => undefined);
    if (!handle) {
      return undefined;
    }
    try {
      const stat = await handle.stat();
      let position = start;
      let nextSeq = startSeq;
      let pending = Buffer.alloc(0);
      let checkpoint = start;
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (position < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, position);
        if (bytesRead === 0) {
          break;
        }
        position += bytesRead;
        pending = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : Buffer.from(chunk.subarray(0, bytesRead));
        let newline: number;
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          checkpoint += newline + 1;
          if (line.length === 0) {
            continue;
          }
          const record = convertClaudeTranscriptLine(line, nextSeq + 1);
          if (record) {
            nextSeq += 1;
            onRecord(record);
          }
        }
      }
      return { offset: checkpoint, seq: nextSeq, ino: stat.ino };
    } finally {
      await handle.close();
    }
  };

  return {
    filePath,
    get lastSeq() {
      return lastSeq;
    },
    async bootstrap(afterSeq) {
      const stat = await statOrUndefined(filePath);
      if (!stat) {
        return { records: [], oversized: false };
      }
      if (stat.size > MAX_TAILED_TRANSCRIPT_BYTES) {
        return { records: [], oversized: true };
      }
      // Keep the newest window: bounded by record count and bytes, oldest evicted first.
      const window: ClaudeTranscriptRecord[] = [];
      let windowBytes = 0;
      let dropped = false;
      const result = await scanFrom(0, 0, (record) => {
        if (record.seq <= afterSeq) {
          return;
        }
        window.push(record);
        windowBytes += Buffer.byteLength(record.text, "utf8");
        while (
          window.length > LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS ||
          (window.length > 1 && windowBytes > LOCAL_SESSION_BOOTSTRAP_MAX_BYTES)
        ) {
          const evicted = window.shift();
          windowBytes -= Buffer.byteLength(evicted?.text ?? "", "utf8");
          dropped = true;
        }
      });
      if (!result) {
        return { records: [], oversized: false };
      }
      offset = result.offset;
      seq = result.seq;
      ino = result.ino;
      lastSeq = seq;
      const earliest = window[0]?.seq;
      return {
        records: window,
        ...(earliest !== undefined && (dropped || afterSeq > 0) ? { earliestSeq: earliest } : {}),
        oversized: false,
      };
    },
    async readNext() {
      const stat = await statOrUndefined(filePath);
      if (!stat) {
        return { records: [], missing: true };
      }
      const rewritten = (ino !== undefined && stat.ino !== ino) || stat.size < offset;
      if (rewritten) {
        offset = 0;
        seq = 0;
      } else if (stat.size === offset) {
        return { records: [], missing: false };
      }
      const records: ClaudeTranscriptRecord[] = [];
      const result = await scanFrom(offset, seq, (record) => {
        // After a rewrite only records past the last handed-out seq are new to the Gateway.
        if (record.seq > lastSeq) {
          records.push(record);
        }
      });
      if (!result) {
        return { records: [], missing: true };
      }
      offset = result.offset;
      seq = result.seq;
      ino = result.ino;
      lastSeq = Math.max(lastSeq, seq);
      return { records, missing: false };
    },
  };
}
