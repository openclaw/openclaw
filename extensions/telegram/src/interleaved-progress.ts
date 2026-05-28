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
  // DEPLOY-LOCAL: on-by-default for this build. Upstream PR keeps the gate
  // opt-in (=== true); this deploy flips to !== false so the interleaved lane
  // engages without operator config, while still respecting an explicit
  // `interleavedProgress: false` override.
  return (
    params.toolProgressEnabled && params.configEnabled !== false && params.hasReasoningLane
  );
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
}): string {
  const now = params.now ?? Date.now();
  const timerSuffix =
    params.timerStartedAt !== undefined
      ? `\n_${Math.floor((now - params.timerStartedAt) / 1000)}s — still running_`
      : "";
  return `Thinking\n\n${params.body.trimEnd()}${timerSuffix}`;
}

/**
 * Append the newly-arrived portion of the reasoning stream to the body,
 * handling both reasoning producers:
 * - Cumulative snapshots (e.g. Claude): each chunk is the full reasoning so
 *   far, so the new chunk prefix-extends the previous one — append only the
 *   suffix, and skip identical re-deliveries.
 * - Deltas (e.g. Codex app-server's `onReasoningStream({ text: delta })`):
 *   each chunk is a fresh fragment that does NOT prefix-extend the previous
 *   one — append it whole. (Slicing by a length checkpoint would drop a
 *   same-size-or-shorter later delta entirely.)
 *
 * `previousBodyOnly` carries the last chunk's header-stripped text so the next
 * call can tell the two modes apart.
 */
export function appendReasoningBody(params: {
  body: string;
  previousBodyOnly: string;
  formattedReasoning: string;
}): { body: string; previousBodyOnly: string } {
  const bodyOnly = stripReasoningHeader(params.formattedReasoning);
  if (!bodyOnly) {
    return { body: params.body, previousBodyOnly: params.previousBodyOnly };
  }
  const isCumulative =
    params.previousBodyOnly !== "" && bodyOnly.startsWith(params.previousBodyOnly);
  const newPart = isCumulative ? bodyOnly.slice(params.previousBodyOnly.length) : bodyOnly;
  if (!newPart) {
    return { body: params.body, previousBodyOnly: bodyOnly };
  }
  return { body: params.body + newPart, previousBodyOnly: bodyOnly };
}

/**
 * Append a timestamped status line to the body. Returns the body unchanged when
 * the sanitized line is empty.
 */
export function appendStatusLine(params: {
  body: string;
  line: string;
  timestamp: string;
  maxChars?: number;
}): string {
  const text = sanitizeInterleavedLine(params.line, params.maxChars);
  if (!text) {
    return params.body;
  }
  return `${params.body}\n[${params.timestamp}] ${text}\n`;
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
