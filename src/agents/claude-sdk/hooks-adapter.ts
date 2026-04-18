// Translate OpenClaw HookEntry[] into the Claude Agent SDK's
// `Partial<Record<HookEvent, HookCallbackMatcher[]>>` shape.
//
// OpenClaw hooks declare their events as free-form strings like
// `"session:start"` or `"tool:pre"` (see `src/hooks/types.ts`). The SDK
// uses a closed enum:
//   "PreToolUse" | "PostToolUse" | "PostToolUseFailure" |
//   "Notification" | "UserPromptSubmit" | "SessionStart" | "SessionEnd" |
//   "Stop" | "SubagentStart" | "SubagentStop" | "PreCompact" |
//   "PermissionRequest"
//
// This adapter:
//   * Maps the well-known OpenClaw event names to SDK events via
//     `OPENCLAW_TO_SDK_EVENT`.
//   * Groups OpenClaw HookEntrys by the mapped SDK event, producing one
//     SDK callback per entry that invokes the user's hook handler and
//     returns a minimal `HookJSONOutput` ({ continue: true } by default).
//   * Drops (with a warning via the supplied `log` function) any OpenClaw
//     event that has no SDK equivalent — per the plan, we do not silently
//     discard these.
//
// Phase 2 scope: hook loading itself stays in OpenClaw's existing
// infrastructure. This module only produces the SDK-shaped record; the
// actual handler invocation is delegated to the `invokeOpenClawHook`
// callback the caller supplies. Keeping it narrow means we don't duplicate
// hook-loading policy (allowlists, enable/disable, plugin source trust)
// from `src/hooks/*`.

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { HookEntry } from "../../hooks/types.js";

/**
 * Mapping from OpenClaw event string → SDK `HookEvent`. Values not
 * present here are dropped with a warning.
 */
export const OPENCLAW_TO_SDK_EVENT: Readonly<Record<string, HookEvent>> = {
  "session:start": "SessionStart",
  "session:end": "SessionEnd",
  "tool:pre": "PreToolUse",
  "tool:post": "PostToolUse",
  "tool:post_failure": "PostToolUseFailure",
  "user:prompt": "UserPromptSubmit",
  notification: "Notification",
  stop: "Stop",
  "subagent:start": "SubagentStart",
  "subagent:end": "SubagentStop",
  "compact:pre": "PreCompact",
  "permission:request": "PermissionRequest",
};

export type InvokeOpenClawHook = (params: {
  entry: HookEntry;
  sdkEvent: HookEvent;
  input: HookInput;
  signal: AbortSignal;
}) => Promise<HookJSONOutput | undefined>;

export type BuildSdkHooksParams = {
  entries: readonly HookEntry[];
  invoke: InvokeOpenClawHook;
  /** Called once per dropped event name. Keep output visible so devs notice. */
  warn?: (msg: string) => void;
};

/**
 * Build the `hooks` record handed to `query({ options: { hooks } })`.
 *
 * Entries whose `events` array is empty (or entirely unmappable) are
 * simply omitted from the output — not an error, just nothing to run.
 */
export function buildSdkHooks(
  params: BuildSdkHooksParams,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { entries, invoke } = params;
  const warn = params.warn ?? (() => {});
  const grouped = new Map<HookEvent, HookCallback[]>();
  const droppedEvents = new Set<string>();
  let disabledCount = 0;

  for (const entry of entries) {
    // Respect the per-entry enable policy. `HookInvocationPolicy.enabled`
    // defaults to true when frontmatter omits it (see
    // `resolveHookInvocationPolicy`), so `enabled === false` here is an
    // explicit opt-out and we must not register the hook with the SDK.
    // Without this check, `enabled: false` in a HOOK.md frontmatter was
    // silently ignored on the claude-sdk runtime while pi-embedded would
    // have treated it as disabled — a correctness regression.
    if (entry.invocation && entry.invocation.enabled === false) {
      disabledCount += 1;
      continue;
    }
    const events = entry.metadata?.events ?? [];
    for (const ev of events) {
      const sdkEvent = OPENCLAW_TO_SDK_EVENT[ev];
      if (!sdkEvent) {
        droppedEvents.add(ev);
        continue;
      }
      const cb: HookCallback = async (input, _toolUseID, opts) => {
        const result = await invoke({
          entry,
          sdkEvent,
          input,
          signal: opts.signal,
        });
        // Default behavior: continue. If a hook wants to block, it returns
        // `{ continue: false }` or a decision object from its handler.
        return result ?? ({ continue: true } as HookJSONOutput);
      };
      const bucket = grouped.get(sdkEvent);
      if (bucket) {
        bucket.push(cb);
      } else {
        grouped.set(sdkEvent, [cb]);
      }
    }
  }

  if (droppedEvents.size > 0) {
    const names = [...droppedEvents].toSorted((a, b) => a.localeCompare(b)).join(", ");
    warn(
      `[claude-sdk hooks] Dropped ${droppedEvents.size} OpenClaw hook event(s) with no SDK equivalent: ${names}`,
    );
  }
  if (disabledCount > 0) {
    warn(
      `[claude-sdk hooks] Skipped ${disabledCount} hook entr${disabledCount === 1 ? "y" : "ies"} with invocation.enabled === false`,
    );
  }

  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const [sdkEvent, callbacks] of grouped) {
    // One matcher per event — no pattern needed since OpenClaw hooks don't
    // use the SDK's matcher regex feature.
    out[sdkEvent] = [{ hooks: callbacks }];
  }
  return out;
}
