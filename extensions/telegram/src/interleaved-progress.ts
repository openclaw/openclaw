/**
 * Pure helpers for the opt-in Telegram "interleaved progress" lane.
 *
 * The renderer in bot-message-dispatch.ts owns the mutable state (accumulated
 * body, reasoning checkpoint, rolling-timer handle) and the side effects
 * (setInterval, draft-stream updates). Everything that decides *what text to
 * show* lives here so it can be unit-tested without the dispatch harness.
 *
 * Projection-only: none of this changes prompts, routing, tools, or auth — it
 * only formats already-authorized event data into one durable live message.
 */

/** Max characters kept from any single status line before it is appended. */
export const INTERLEAVED_LINE_MAX_CHARS = 200;

/**
 * Budget for the *visible* portion of the interleaved message. Telegram caps a
 * message at 4096 chars and the durable draft stream STOPS editing (freezes)
 * the moment a render exceeds that — so the lane must spill into a continuation
 * message before reaching it. Held well under 4096 to leave room for the
 * "Thinking" header, the rolling-timer suffix, and HTML/markdown expansion.
 */
export const INTERLEAVED_MESSAGE_MAX_CHARS = 3900;

/**
 * When the message fills up and spills into a fresh continuation message, carry
 * roughly this many trailing chars (snapped to a line boundary) into the new
 * message so recent progress stays visible across the break instead of leaving
 * a hard gap.
 */
export const INTERLEAVED_SPILL_OVERLAP_CHARS = 600;

/**
 * Decide whether the accumulated body has outgrown the *current* message and, if
 * so, where the continuation message should start. `offset` is how many leading
 * chars of `body` already live in prior (rotated-away) messages; the visible
 * portion is `body.slice(offset)`. Returns the new offset (advanced, snapped to
 * a line boundary, carrying `overlapChars` of trailing context) when a spill is
 * needed, else the unchanged offset. Pure so the dispatch can rotate the draft
 * stream deterministically and it can be unit-tested without the harness.
 */
export function computeInterleavedSpill(params: {
  body: string;
  offset: number;
  maxChars?: number;
  overlapChars?: number;
}): { offset: number; spilled: boolean } {
  const maxChars = params.maxChars ?? INTERLEAVED_MESSAGE_MAX_CHARS;
  const overlap = params.overlapChars ?? INTERLEAVED_SPILL_OVERLAP_CHARS;
  const offset = Math.max(0, Math.min(params.offset, params.body.length));
  if (params.body.length - offset <= maxChars) {
    return { offset, spilled: false };
  }
  let newOffset = Math.max(offset, params.body.length - overlap);
  const nl = params.body.indexOf("\n", newOffset);
  if (nl >= 0 && nl < params.body.length - 1) {
    newOffset = nl + 1;
  }
  // A single line longer than the overlap window leaves no clean boundary — fall
  // back to a hard advance so the continuation is guaranteed to start smaller.
  if (newOffset <= offset) {
    newOffset = Math.max(offset, params.body.length - Math.min(overlap, maxChars));
  }
  return { offset: newOffset, spilled: newOffset > offset };
}

/**
 * Gate for the interleaved lane. It is enabled only when preview tool progress
 * is already enabled (so it inherits all existing group/DM/visibility gating),
 * the operator explicitly opted in, and a reasoning lane exists to render into.
 * When this is false the renderer is inert and callers fall back to the default
 * tool-progress lane — preserving current behaviour exactly.
 */
export function resolveInterleavedProgressEnabled(params: {
  toolProgressEnabled: boolean;
  configEnabled: boolean | undefined;
  hasReasoningLane: boolean;
}): boolean {
  return params.toolProgressEnabled && params.configEnabled === true && params.hasReasoningLane;
}

/**
 * Collapse whitespace, trim, and length-cap a status line. Callers must pass
 * already-safe text (tool name or event title — never raw args or command
 * output); this is the final defensive normalisation before rendering.
 */
export function sanitizeInterleavedLine(
  line: string,
  maxChars: number = INTERLEAVED_LINE_MAX_CHARS,
): string {
  return line.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

/**
 * `formatReasoningMessage` (via splitTelegramReasoningText) prepends a plain
 * "Thinking\n\n" header to the italic body. The interleaved renderer supplies
 * its own single header, so the body must be stored header-stripped to avoid a
 * duplicated heading. The header is plain text; body lines are `_…_`, so this
 * strip can never touch body content.
 */
export function stripReasoningHeader(formatted: string): string {
  return formatted.replace(/^Thinking\n\n/u, "");
}

/**
 * Render the full interleaved message: the single "Thinking" header, the
 * accumulated body, and (while a tool is running) a rolling-timer suffix. When
 * `timerStartedAt` is undefined the suffix is absent, so the rendered text is a
 * strict-shorter superseding update — the live-chat merger replaces rather than
 * appends, clearing a previously-painted timer line.
 */
export function renderInterleavedMessage(params: {
  body: string;
  timerStartedAt?: number;
  now?: number;
  maxChars?: number;
}): string {
  const now = params.now ?? Date.now();
  const timerSuffix =
    params.timerStartedAt !== undefined
      ? `\n_${Math.floor((now - params.timerStartedAt) / 1000)}s — still running_`
      : "";
  let body = params.body.trimEnd();
  // Safety net: spill-by-offset keeps the visible body small in the normal case,
  // but a single append larger than a whole message could still overflow. Cap
  // the body to the most-recent content (line boundary) so a render NEVER
  // exceeds the limit and freezes the stream; a leading ellipsis marks the trim.
  if (params.maxChars !== undefined) {
    const budget = params.maxChars - "Thinking\n\n".length - timerSuffix.length - 2;
    if (budget > 0 && body.length > budget) {
      const tail = body.slice(body.length - budget);
      const nl = tail.indexOf("\n");
      body = `…\n${nl >= 0 ? tail.slice(nl + 1) : tail}`;
    }
  }
  return `Thinking\n\n${body}${timerSuffix}`;
}

/**
 * Strip per-line italic wrappers (`_…_`) so cumulative snapshot detection
 * compares raw content, not markdown. Without this, `_alpha beta_` does not
 * `startsWith("_alpha_")` because the closing underscore of the first snapshot
 * collides with the space in the extended snapshot.
 */
function stripLineItalics(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith("_") && l.endsWith("_") && l.length > 1 ? l.slice(1, -1) : l))
    .join("\n");
}

/** Mutable per-stream checkpoint for delta-based appends. `previousText` is the
 * last cumulative text seen for the stream (to convert cumulative snapshots to
 * deltas); `lastIncrement` is what the stream last appended (to overwrite on a
 * replace snapshot). */
export type InterleavedStreamState = { previousText: string; lastIncrement: string };

export function emptyInterleavedStreamState(): InterleavedStreamState {
  return { previousText: "", lastIncrement: "" };
}

/**
 * Append the NEW increment of a streaming text block (reasoning or assistant
 * commentary) to the interleaved body, in arrival order.
 *
 * Delta model — not cumulative-replace. We only ever append the portion of a
 * stream that has not been appended yet, and never re-stamp text already in the
 * body. That is what keeps tool lines interleaved chronologically and stops a
 * cumulative producer (which re-sends the full text after every tool line) from
 * duplicating everything before each tool boundary — the bug that caused the
 * same block to appear N times across N tool calls.
 *
 * - `delta` present (true delta producers): append it verbatim.
 * - cumulative snapshot (prefix-extends the previous text): append only the new
 *   suffix.
 * - `replace` snapshot (non-prefix, e.g. "Working…" -> "Done."): strip the last
 *   increment this stream appended (when it is still at the body tail) and
 *   append the replacement, so stale partial text is not left behind.
 * - otherwise (a fresh, non-prefix fragment): append it whole.
 */
export function appendInterleavedDelta(params: {
  body: string;
  state: InterleavedStreamState;
  text: string;
  delta?: string;
  replace?: boolean;
}): { body: string; state: InterleavedStreamState } {
  const { previousText, lastIncrement } = params.state;
  let increment: string;
  let nextPreviousText: string;
  if (typeof params.delta === "string") {
    increment = params.delta;
    nextPreviousText =
      params.text.length >= previousText.length ? params.text : previousText + params.delta;
  } else if (previousText !== "" && params.text.startsWith(previousText)) {
    increment = params.text.slice(previousText.length);
    nextPreviousText = params.text;
  } else {
    increment = params.text;
    nextPreviousText = params.text;
  }
  let body = params.body;
  if (params.replace === true && lastIncrement !== "" && body.endsWith(lastIncrement)) {
    body = body.slice(0, body.length - lastIncrement.length);
  } else {
    // Cross-stream dedup. The reasoning and assistant streams append to ONE body
    // via SEPARATE per-stream checkpoints, so when the same text reaches both
    // lanes — e.g. a redacted-thinking turn where the assistant text is also
    // bridged onto the reasoning stream — each computes its own "new" suffix and
    // the words interleave into a doubled mess. Fold away any leading run of this
    // increment that already sits at the tail of the body's current prose block,
    // so the second stream contributes only genuinely-new text. The first stream
    // still streams live word by word; distinct content shares no tail overlap
    // and is appended whole. Skipped on `replace` (it manages its own tail).
    increment = dropBodyTailOverlap(body, increment);
  }
  if (increment === "") {
    return { body, state: { previousText: nextPreviousText, lastIncrement } };
  }
  return {
    body: body + increment,
    state: { previousText: nextPreviousText, lastIncrement: increment },
  };
}

// Minimum overlap length (chars) before cross-stream dedup folds at a
// non-boundary position. Full-increment overlaps (the ENTIRE increment already
// sits at the body tail) are always folded regardless of length — that is the
// canonical cross-stream duplicate case. Partial overlaps must reach this
// threshold so ordinary streaming (whose increments are genuinely new short
// tokens) is untouched.
const INTERLEAVED_MIN_PARTIAL_OVERLAP = 10;

/**
 * Return `increment` with any leading run that already appears at the tail of
 * `body`'s current prose block removed. The comparison never crosses a
 * synthesized tool/status line (`\n[HH:MM:SS] …`) — those are hard checkpoints
 * that prose overlap can't span. Partial-overlap cuts must land on a word
 * boundary so a surviving word is never split.
 */
function dropBodyTailOverlap(body: string, increment: string): string {
  if (!increment) {
    return increment;
  }
  // Prose tail = trailing body lines up to (not including) the last status line.
  const lines = body.split("\n");
  const proseLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\[\d/u.test(lines[i]?.trimStart() ?? "")) {
      break;
    }
    proseLines.unshift(lines[i] ?? "");
  }
  const tail = proseLines.join("\n");
  if (!tail) {
    return increment;
  }
  // Full-increment match: the entire increment is already at the body tail.
  // Always fold — this is the canonical cross-stream duplicate (e.g. "There"
  // already committed by stream A, now arriving again on stream B).
  if (tail.endsWith(increment)) {
    return "";
  }
  // Tail-as-prefix: the body tail ends with a prefix of the increment (e.g.
  // body ends with "There", increment is "There it is."). Find the longest
  // suffix of tail that matches a prefix of increment and strip it.
  const scanLen = Math.min(tail.length, increment.length);
  for (let k = scanLen; k >= 1; k -= 1) {
    if (tail.endsWith(increment.slice(0, k))) {
      return increment.slice(k);
    }
  }
  // Partial overlap: only fold if above the minimum threshold and at a word
  // boundary, to avoid folding genuinely-new short streaming tokens.
  if (increment.length < INTERLEAVED_MIN_PARTIAL_OVERLAP) {
    return increment;
  }
  const maxK = Math.min(tail.length, increment.length);
  for (let k = maxK; k >= INTERLEAVED_MIN_PARTIAL_OVERLAP; k -= 1) {
    if (k < increment.length) {
      const before = increment[k - 1] ?? "";
      const after = increment[k] ?? "";
      if (/\w/u.test(before) && /\w/u.test(after)) {
        continue;
      }
    }
    if (tail.endsWith(increment.slice(0, k))) {
      return increment.slice(k);
    }
  }
  return increment;
}

/**
 * Append a timestamped status line to the body. Returns the body unchanged when
 * the sanitized line is empty or identical to `previousLine` (deduplicates
 * consecutive start/update phases for the same tool invocation).
 */
export function appendStatusLine(params: {
  body: string;
  line: string;
  timestamp: string;
  previousLine?: string;
  maxChars?: number;
}): { body: string; appendedLine: string | undefined } {
  const text = sanitizeInterleavedLine(params.line, params.maxChars);
  if (!text || text === params.previousLine) {
    return { body: params.body, appendedLine: undefined };
  }
  return {
    body: `${params.body}\n[${params.timestamp}] ${text}\n`,
    appendedLine: text,
  };
}

/**
 * Normalise a block of interleaved text for dedup comparison: collapse runs of
 * whitespace, strip per-line italic wrappers, and trim. The streamed final
 * answer may carry markdown/whitespace that differs from the transcript-backed
 * canonical final text, so the strip below compares normalised forms.
 */
function normaliseForDedup(text: string): string {
  return stripLineItalics(text).replace(/\s+/gu, " ").trim();
}

/**
 * Remove the final answer from the tail of the interleaved body so it is not
 * shown twice (once as trailing commentary in the durable thinking message, and
 * again as the polished final answer in the answer lane).
 *
 * Conservative by design: it only strips a trailing run of body lines whose
 * normalised concatenation matches the normalised final text. If no confident
 * tail match is found the body is returned unchanged — the dedup never corrupts
 * the lane, it only ever removes a redundant final answer it is sure about.
 */
export function stripFinalAnswerFromInterleavedBody(params: {
  body: string;
  finalText: string;
}): string {
  const target = normaliseForDedup(params.finalText);
  if (!target) {
    return params.body;
  }
  const lines = params.body.split("\n");
  // Walk back from the tail, accumulating lines until their normalised join
  // matches the final text. Stop at a timestamped status line — tool/event
  // checkpoints are never part of the final answer prose.
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (/^\[\d/u.test(lines[start]?.trimStart() ?? "")) {
      break;
    }
    const candidate = normaliseForDedup(lines.slice(start).join("\n"));
    if (candidate === target) {
      return lines.slice(0, start).join("\n").trimEnd();
    }
    if (candidate.length > target.length) {
      // The candidate only grows as we walk further back, so once it is longer
      // than the target without matching it can never match — stop.
      break;
    }
  }
  return params.body;
}

/**
 * Choose the interleaved lane's text for a tool start. Default is the tool name
 * only — args/detail are shown ONLY when the operator opts into
 * `interleavedToolArgs` AND a sanitized detail line was produced. Falls back to
 * the tool name (or a generic label) otherwise, so tool args never appear by
 * default. `sanitizedLine` must already be the sanitized formatter output.
 */
export function resolveInterleavedToolLine(params: {
  showArgs: boolean;
  sanitizedLine: string | undefined;
  toolName: string | undefined;
}): string {
  const nameOnly = params.toolName ? `tool: ${params.toolName}` : "tool running";
  return params.showArgs && params.sanitizedLine ? params.sanitizedLine : nameOnly;
}
