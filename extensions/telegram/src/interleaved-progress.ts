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
  return (
    params.toolProgressEnabled && params.configEnabled === true && params.hasReasoningLane
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
 * Append the newly-arrived portion of the reasoning stream to the body. The
 * checkpoint tracks how much of the (header-stripped) formatted reasoning has
 * already been consumed so re-delivered cumulative text is not duplicated.
 */
export function appendReasoningBody(params: {
  body: string;
  checkpoint: number;
  formattedReasoning: string;
}): { body: string; checkpoint: number } {
  const bodyOnly = stripReasoningHeader(params.formattedReasoning);
  const newPart = bodyOnly.slice(params.checkpoint);
  if (!newPart) {
    return { body: params.body, checkpoint: params.checkpoint };
  }
  return { body: params.body + newPart, checkpoint: bodyOnly.length };
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
