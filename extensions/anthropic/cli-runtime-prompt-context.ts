import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";

// Claude Code caps each hook's additionalContext at 10,000 UTF-16 code units.
const HOOK_CONTEXT_MAX_CHARS = 10_000;
// A 160,000-unit result can expand sevenfold through runtime and transport JSON
// encoding. 128 hooks leave room for that expansion, labels, and safe cuts.
// Text beyond the last segment still uses Claude's existing file fallback.
export const PROMPT_CONTEXT_HOOK_IDS = Array.from({ length: 128 }, (_, slot) =>
  slot === 0 ? "UserPromptSubmit" : `UserPromptSubmit:${slot}`,
);

/** The prompt-context segment a UserPromptSubmit callback carries, or -1 for other callbacks. */
export function promptContextHookSlot(callbackId: unknown): number {
  return typeof callbackId === "string" ? PROMPT_CONTEXT_HOOK_IDS.indexOf(callbackId) : -1;
}

/** One callback's part of the turn's private context; empty when the context is shorter. */
export function promptContextHookValue(
  promptContext: CliBackendExecuteContext["promptContext"],
  slot: number,
): string {
  const context = [promptContext?.prependContext, promptContext?.appendContext]
    .filter(Boolean)
    .join("\n\n");
  if (context.length <= HOOK_CONTEXT_MAX_CHARS) {
    return slot === 0 ? context : "";
  }
  // Native renders separate hook-named reminders, not contiguous text. Give each
  // segment a complete JSON string rather than exposing a raw data continuation.
  // Escaping '<' also keeps native reminder-tag sanitization from changing data.
  const encoded = JSON.stringify(context).slice(1, -1).replaceAll("<", "\\u003c");
  for (let index = 0, start = 0; ; index++) {
    if (start === encoded.length) {
      return "";
    }
    const prefix = `OpenClaw private context segment ${index + 1} (JSON string; concatenate decoded segments in order without separators, preserving original instruction/data labels):\n`;
    const last = index === PROMPT_CONTEXT_HOOK_IDS.length - 1;
    let end = last
      ? encoded.length
      : Math.min(start + HOOK_CONTEXT_MAX_CHARS - prefix.length - 2, encoded.length);
    // Keep a JSON escape (including \uXXXX) wholly inside one quoted segment.
    const escape = encoded.lastIndexOf("\\", end - 1);
    if (escape >= start && escape >= end - 5) {
      let first = escape;
      while (first > start && encoded[first - 1] === "\\") {
        first--;
      }
      if (
        (escape - first) % 2 === 0 &&
        (escape === end - 1 || (encoded[escape + 1] === "u" && escape + 6 > end))
      ) {
        end = escape;
      }
    }
    const code = encoded.charCodeAt(end - 1);
    if (end < encoded.length && code >= 0xd800 && code <= 0xdbff) {
      end--;
    }
    if (index === slot) {
      return `${prefix}"${encoded.slice(start, end)}"`;
    }
    start = end;
  }
}
