import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Stream-json output limits and raw-line framing for the CLI streaming parser.
// Kept beside `cli-output-stream.ts` so the parser stays within the file-size
// budget; the limits are process constants, not per-backend configuration.
import { normalizeClaudeCliStreamJsonRecord } from "./cli-output-echoed-binary.js";
import { readClaudeAttributedSubagentProgressId } from "./cli-output-records.js";

const CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES = 20_000;
export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxTurnLines: CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES,
});

// Claude Code attaches `api_message_id` to every stream event frame and the
// `thinking_display` display setting to thinking frames. The parser reads
// neither; both stay bounded, and `thinking_display` only on thinking deltas.
const PARTIAL_RECORD_METADATA_LIMITS = {
  uuid: 128,
  session_id: 128,
  parent_tool_use_id: 128,
  api_message_id: 64,
  thinking_display: 32,
} as const;
const PARTIAL_RECORD_KEYS = new Set([
  "type",
  "event",
  ...Object.keys(PARTIAL_RECORD_METADATA_LIMITS),
]);
const PARTIAL_EVENT_KEYS = new Set(["type", "index", "delta"]);

/** The event of a stream_event record with bounded metadata and a valid block index. */
function readBoundedStreamEvent(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    parsed.type !== "stream_event" ||
    !isRecord(parsed.event) ||
    Object.keys(parsed).some((key) => !PARTIAL_RECORD_KEYS.has(key))
  ) {
    return undefined;
  }
  for (const [key, limit] of Object.entries(PARTIAL_RECORD_METADATA_LIMITS)) {
    const value = parsed[key];
    if (value != null && (typeof value !== "string" || value.length > limit)) {
      return undefined;
    }
  }
  const index = parsed.event.index;
  if (
    index !== undefined &&
    (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
  ) {
    return undefined;
  }
  return parsed.event;
}

/** Discount recognized token envelopes, retaining payload, padding, and a per-frame budget. */
function measureClaudePartialMessage(
  parsed: Record<string, unknown>,
  rawLine: string,
): number | undefined {
  const event = readBoundedStreamEvent(parsed);
  if (
    event?.type !== "content_block_delta" ||
    !isRecord(event.delta) ||
    Object.keys(event).some((key) => !PARTIAL_EVENT_KEYS.has(key))
  ) {
    return undefined;
  }
  const delta = event.delta;
  const field =
    delta.type === "text_delta"
      ? "text"
      : delta.type === "thinking_delta"
        ? "thinking"
        : delta.type === "input_json_delta"
          ? "partial_json"
          : undefined;
  const payload = field ? delta[field] : undefined;
  if (
    typeof payload !== "string" ||
    !payload ||
    (parsed.thinking_display != null && delta.type !== "thinking_delta") ||
    Object.keys(delta).some(
      (key) =>
        key !== "type" &&
        key !== field &&
        !(delta.type === "thinking_delta" && key === "estimated_tokens"),
    )
  ) {
    return undefined;
  }
  const estimatedTokens = delta.estimated_tokens;
  if (
    estimatedTokens != null &&
    (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens))
  ) {
    return undefined;
  }
  // The fixed charge bounds tiny delta floods and retained chunk bookkeeping:
  // the smallest frame costs 36 characters with its newline, so the 8 MiB
  // budget admits at most 233,016 partial frames. Metadata is not charged: the
  // per-field caps allow up to 480 characters of values per frame, so a flood
  // can pass more raw bytes through the parser than the budget counts. Empty
  // deltas, unknown fields, and oversized metadata keep the ordinary raw/frame
  // limits.
  return (
    JSON.stringify(payload).length +
    32 +
    (estimatedTokens === undefined
      ? 0
      : JSON.stringify({ estimated_tokens: estimatedTokens }).length) +
    Math.max(0, rawLine.length - JSON.stringify(parsed).length)
  );
}

const CONTROL_FRAME_EVENT_KEYS = new Map<unknown, ReadonlySet<string>>([
  ["content_block_start", new Set(["type", "index", "content_block"])],
  ["content_block_delta", new Set(["type", "index", "delta"])],
  ["content_block_stop", new Set(["type", "index"])],
  ["message_stop", new Set(["type"])],
  ["message_delta", new Set(["type", "delta", "usage", "context_management"])],
]);
const PROGRESS_DELTA_KEYS = new Set(["type", "thinking", "estimated_tokens"]);
const SIGNATURE_DELTA_KEYS = new Set(["type", "signature"]);
// At most 8 KiB of a discarded signature or envelope goes uncharged.
const CONTROL_FRAME_DISCARDED_ALLOWANCE_CHARS = 8 * 1024;

/**
 * Fixed charge for stream events whose content the parser discards: thinking
 * progress (only `estimated_tokens` is read), block starts (only the block
 * header is kept), block/message stops, and signatures and message deltas,
 * which are charged beyond their discarded allowance.
 */
function measureClaudeStreamControlFrame(
  parsed: Record<string, unknown>,
  rawLine: string,
): number | undefined {
  const event = readBoundedStreamEvent(parsed);
  const eventKeys = event ? CONTROL_FRAME_EVENT_KEYS.get(event.type) : undefined;
  if (!event || !eventKeys || Object.keys(event).some((key) => !eventKeys.has(key))) {
    return undefined;
  }
  const delta = isRecord(event.delta) ? event.delta : {};
  const progressTokens = delta.estimated_tokens;
  const progress =
    delta.type === "thinking_delta" &&
    delta.thinking === "" &&
    (progressTokens === null ||
      (typeof progressTokens === "number" && Number.isFinite(progressTokens))) &&
    Object.keys(delta).every((key) => PROGRESS_DELTA_KEYS.has(key));
  const signature =
    delta.type === "signature_delta" &&
    typeof delta.signature === "string" &&
    delta.signature.length > 0 &&
    Object.keys(delta).every((key) => SIGNATURE_DELTA_KEYS.has(key));
  if (
    (event.type === "content_block_delta" && !progress && !signature) ||
    (event.type === "content_block_start" && !isRecord(event.content_block)) ||
    (parsed.thinking_display != null && !progress)
  ) {
    return undefined;
  }
  const discarded = signature || event.type === "message_delta";
  const padding = Math.max(0, rawLine.length - JSON.stringify(parsed).length);
  if (discarded) {
    const overflow = rawLine.length - CONTROL_FRAME_DISCARDED_ALLOWANCE_CHARS;
    return 32 + Math.max(padding, overflow);
  }
  const retainedChars = progress
    ? JSON.stringify({ estimated_tokens: progressTokens }).length
    : event.type === "content_block_start"
      ? JSON.stringify(event.content_block).length
      : 0;
  return 32 + retainedChars + padding;
}

/**
 * Each model request opens with a `message_start` event and a `system/status`
 * record whose metadata the parser discards; it reads at most their ids and usage.
 */
function measureClaudeRequestEnvelope(
  parsed: Record<string, unknown>,
  rawLine: string,
): number | undefined {
  const envelope =
    (parsed.type === "stream_event" &&
      isRecord(parsed.event) &&
      parsed.event.type === "message_start") ||
    (parsed.type === "system" && parsed.subtype === "status");
  return envelope
    ? 32 + Math.max(0, rawLine.length - CONTROL_FRAME_DISCARDED_ALLOWANCE_CHARS)
    : undefined;
}

/** Assistant snapshots keep only their content blocks; envelope and metadata are discarded. */
function measureClaudeAssistantMessage(parsed: Record<string, unknown>): number | undefined {
  const content = isRecord(parsed.message) ? parsed.message.content : undefined;
  return parsed.type === "assistant" && Array.isArray(content)
    ? 32 + JSON.stringify(content).length
    : undefined;
}

/** Pure tool-result records keep only their tool ids; payloads go to consumers unretained. */
function measureClaudeToolResultMessage(parsed: Record<string, unknown>): number | undefined {
  const content = isRecord(parsed.message) ? parsed.message.content : undefined;
  if (parsed.type !== "user" || !Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  let idChars = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return undefined;
    }
    idChars += block.tool_use_id.length;
  }
  return 32 + idChars;
}

// Forwarded child message payloads are discarded; only their progress id survives.
// Stream events can retain text even with child attribution, so keep their full charge.
const CLAUDE_SUBAGENT_RECORD_CHARS = 64;

/** Fixed charge only for child message records the parser discards. */
function measureClaudeSubagentRecord(parsed: Record<string, unknown>): number | undefined {
  if ((parsed.type !== "assistant" && parsed.type !== "user") || parsed.item != null) {
    return undefined;
  }
  const parentToolUseId = readClaudeAttributedSubagentProgressId(parsed);
  if (!parentToolUseId || parentToolUseId.length > 128) {
    return undefined;
  }
  return CLAUDE_SUBAGENT_RECORD_CHARS;
}

// The character budget bounds every frame: discounted frames pay at least 32
// characters (at most about 254,000 per turn) and other frames their raw length.
// The frame limit bounds only the JSON the budget does not see: a frame that
// leaves more than 1 KiB of its raw line uncharged counts toward it, so uncounted
// frames add at most about 254 MiB of discarded JSON to a turn's parse work.
const UNCOUNTED_FRAME_MAX_UNCHARGED_CHARS = 1024;

/** Budget charge for one Claude stream-json line, and whether it counts toward the frame limit. */
export function chargeClaudeStreamJsonLine(
  record: Record<string, unknown> | undefined,
  rawLine: string,
): { chars: number; countsFrame: boolean } {
  let discountedChars: number | undefined;
  try {
    discountedChars = record
      ? (measureClaudeSubagentRecord(record) ??
        measureClaudePartialMessage(record, rawLine) ??
        measureClaudeStreamControlFrame(record, rawLine) ??
        measureClaudeRequestEnvelope(record, rawLine) ??
        measureClaudeAssistantMessage(record) ??
        measureClaudeToolResultMessage(record))
      : undefined;
  } catch {
    // A record too deep to re-serialize keeps raw accounting.
  }
  const normalized = record ? normalizeClaudeCliStreamJsonRecord(record) : undefined;
  // Media omission may not erase wire whitespace.
  const chars =
    discountedChars ??
    (normalized
      ? Math.max(normalized.line.length, rawLine.length - normalized.omittedRawChars)
      : rawLine.length);
  return { chars, countsFrame: rawLine.length - chars > UNCOUNTED_FRAME_MAX_UNCHARGED_CHARS };
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

export function streamJsonOutputLimitErrorText(
  kind: "raw" | "line" | "lines",
  limit: number,
): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; refusing to parse output.`;
  }
  if (kind === "lines") {
    return `CLI JSONL output exceeded ${limit} lines; refusing to parse output.`;
  }
  return `CLI JSONL output exceeded ${limit} characters; refusing to parse output.`;
}
