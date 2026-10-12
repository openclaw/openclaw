import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Stream-json output limits and raw-line framing for the CLI streaming parser.
// Kept beside `cli-output-stream.ts` so the parser stays within the file-size
// budget; the limits are process constants, not per-backend configuration.
import type { CliStreamJsonOutputLimits } from "./cli-output-contracts.js";

const CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES = 20_000;
export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxTurnLines: CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES,
} satisfies CliStreamJsonOutputLimits);

const PARTIAL_RECORD_KEYS = new Set(["type", "event", "uuid", "session_id", "parent_tool_use_id"]);
const PARTIAL_EVENT_KEYS = new Set(["type", "index", "delta"]);

/** Discount recognized token envelopes, retaining payload, padding, and a per-frame budget. */
export function measureClaudePartialMessage(
  parsed: Record<string, unknown>,
  rawLine: string,
): number | undefined {
  if (
    parsed.type !== "stream_event" ||
    !isRecord(parsed.event) ||
    Object.keys(parsed).some((key) => !PARTIAL_RECORD_KEYS.has(key))
  ) {
    return undefined;
  }
  for (const key of ["uuid", "session_id", "parent_tool_use_id"]) {
    const value = parsed[key];
    if (value != null && (typeof value !== "string" || value.length > 128)) {
      return undefined;
    }
  }
  const event = parsed.event;
  if (
    event.type !== "content_block_delta" ||
    !isRecord(event.delta) ||
    Object.keys(event).some((key) => !PARTIAL_EVENT_KEYS.has(key)) ||
    (event.index !== undefined &&
      (typeof event.index !== "number" || !Number.isSafeInteger(event.index) || event.index < 0))
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
  // the 8 MiB budget admits fewer than 262,144 partial frames. Empty deltas,
  // unknown fields, and oversized metadata keep the ordinary raw/frame limits.
  return (
    JSON.stringify(payload).length +
    32 +
    (estimatedTokens === undefined
      ? 0
      : JSON.stringify({ estimated_tokens: estimatedTokens }).length) +
    Math.max(0, rawLine.length - JSON.stringify(parsed).length)
  );
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
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
