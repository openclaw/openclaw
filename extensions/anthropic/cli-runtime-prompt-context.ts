import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";

// Claude Code caps each hook's additionalContext at 10,000 characters and spills longer
// values to a file that message-only turns cannot open. Each callback carries one slice.
const HOOK_CONTEXT_MAX_CHARS = 10_000;
// 20 slices cover the 160,000-character completion findings cap plus framing.
// Text beyond the last slice still spills.
export const PROMPT_CONTEXT_HOOK_IDS = Array.from({ length: 20 }, (_, slot) =>
  slot === 0 ? "UserPromptSubmit" : `UserPromptSubmit:${slot}`,
);

/** The prompt-context slice a UserPromptSubmit callback carries, or -1 for other callbacks. */
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
  for (let index = 0, start = 0; ; index++) {
    const last = index === PROMPT_CONTEXT_HOOK_IDS.length - 1;
    let end = last ? context.length : Math.min(start + HOOK_CONTEXT_MAX_CHARS, context.length);
    const code = context.charCodeAt(end - 1);
    // Never split a surrogate pair across two hook values.
    if (end < context.length && code >= 0xd800 && code <= 0xdbff) {
      end--;
    }
    if (index === slot) {
      return context.slice(start, end);
    }
    start = end;
  }
}
