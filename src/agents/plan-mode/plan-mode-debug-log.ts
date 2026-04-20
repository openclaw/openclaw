/**
 * Plan-mode debug log — opt-in instrumentation surface.
 *
 * # Why
 *
 * The plan-mode subsystem has many cross-component touch points (gateway
 * sessions.patch, mutation gate, three plan-mode tools, synthetic
 * injections, nudge crons, subagent spawn/return, approval events,
 * UI toasts). Live debugging today means piecing together evidence from
 * sparse `[gateway]` / `[agent/embedded]` / `[plugins]` log lines plus
 * grep-by-runId across multiple files. This helper centralizes
 * plan-mode-specific events behind a single gate so a debugger (human
 * or agent) can stream the entire plan-mode lifecycle by tailing one
 * file.
 *
 * # Activation (two equivalent paths — either turns logging on)
 *
 * Path A (env var, terminal-launched runs):
 *   OPENCLAW_DEBUG_PLAN_MODE=1 ./openclaw gateway run …
 *
 * Path B (config flag, persistent — recommended for menubar app /
 * launchd-supervised gateway where env-var propagation is unreliable):
 *   openclaw config set agents.defaults.planMode.debug true
 *   # then restart the gateway
 *
 * Off by default — the helper short-circuits at the first line so there
 * is zero perf impact when disabled. To stream:
 *
 *     tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/'
 *
 * # Coverage
 *
 * Every plan-mode state transition, gate decision, tool call, synthetic
 * injection, nudge phase, subagent event, approval action, and UI toast
 * emission. The `kind` discriminator on the event union is the
 * canonical taxonomy of "things that affect plan-mode behavior."
 */
import { loadConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("plan-mode");

/**
 * Discriminated union of every plan-mode lifecycle event the debug log
 * captures. Add new kinds here when instrumenting a new touch point —
 * the union keeps callers honest about what fields each event needs.
 */
// C7 (Plan Mode 1.0 follow-up): correlation fields.
// Operators tracing a single approval cycle across multiple events
// need a shared key beyond `sessionKey` (one session can have many
// approvals in its lifetime). The two correlation keys added to
// relevant events are:
//   - `approvalRunId`: the agent-run ID that produced the plan
//     (persisted on `planMode.approvalRunId` at exit_plan_mode
//     time). Traces events from tool-call → gate decisions →
//     injections within one agent turn.
//   - `approvalId`: the approval-version token minted for each
//     exit_plan_mode call. Traces events across the full approval
//     lifecycle (exit_plan_mode → user decision → state transition).
// Both are optional — pre-existing emitters that don't carry them
// keep the current logging shape; new emitters populate them when
// the field is available at emit time.
export type PlanModeDebugEvent =
  | {
      kind: "state_transition";
      sessionKey: string;
      from: string;
      to: string;
      trigger: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "gate_decision";
      sessionKey: string;
      tool: string;
      allowed: boolean;
      planMode: string | undefined;
      reason?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "tool_call";
      sessionKey: string;
      // Codex P1 review #68939 (2026-04-19): added `ask_user_question`
      // for the question-approvalId persist path in
      // `plan-snapshot-persister.ts`. Same diagnostic shape as the
      // existing plan-mode tool kinds; the persister emits this when
      // it sees an `ask_user_question` approval event so operators
      // can correlate question-tool calls with answer-validation
      // patches in the gateway.err.log debug stream.
      tool: "enter_plan_mode" | "exit_plan_mode" | "update_plan" | "ask_user_question";
      runId: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "synthetic_injection";
      sessionKey: string;
      tag: string;
      preview: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "nudge_event";
      sessionKey: string;
      nudgeId: string;
      phase: "scheduled" | "fired" | "cleaned";
      approvalRunId?: string;
    }
  | {
      kind: "subagent_event";
      sessionKey: string;
      parentRunId: string;
      childRunId: string;
      event: "spawn" | "return";
      approvalRunId?: string;
    }
  | {
      kind: "approval_event";
      sessionKey: string;
      action: string;
      openSubagentCount: number;
      result: "accepted" | "rejected_by_subagent_gate" | "other";
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "toast_event";
      sessionKey: string;
      toast: string;
      phase: "fired" | "dismissed";
      approvalRunId?: string;
      approvalId?: string;
    };

/**
 * Resolve "is debug enabled?" on every call so the gate respects late
 * env-var changes (e.g. tests setting the var via `vi.stubEnv`). Cheap:
 * env-var path is single string compare; config-flag path lazy-loads
 * and short-circuits on any error.
 *
 * Live-test iter-2 Bug D: env-var-only activation (`OPENCLAW_DEBUG_PLAN_MODE=1`)
 * doesn't reliably propagate to the gateway process when supervised
 * by the OpenClaw Mac app (launchd `setenv` only affects future
 * launchd-spawned processes, not running children of the app). The
 * config-flag path (`agents.defaults.planMode.debug: true`) is
 * always reliable because it's read from disk on every call.
 *
 * Order: env-var wins (allows ad-hoc terminal-launched runs); config
 * flag is the persistent path. Either signal turns it on.
 */
function isDebugEnabled(): boolean {
  return isPlanModeDebugEnabled();
}

/**
 * Copilot review #68939 (2026-04-19): exported shared helper for
 * "is plan-mode debug logging enabled?" so callers like
 * `plan_mode_status` can resolve the flag without duplicating the
 * env-wins-over-config logic. Single source of truth for the
 * activation predicate.
 *
 * Returns true when EITHER `OPENCLAW_DEBUG_PLAN_MODE=1` is set in
 * the process env OR `agents.defaults.planMode.debug === true` in
 * the loaded config. Errors loading config are swallowed (returns
 * false), matching the previous local helper's behavior.
 *
 * Copilot review #68939 (post-nuclear-fix-stack): added a 30-second
 * TTL cache on the config-flag read path. Pre-fix, every
 * `logPlanModeDebug()` call invoked `loadConfig()` (file I/O +
 * parse) even when the env var was unset and debug logging was
 * effectively off — significant overhead in hot paths that emit
 * many debug events per turn. The 30s TTL is short enough that an
 * operator flipping the config flag sees the change within half a
 * minute, while bounding the file-I/O overhead at ~2 reads per
 * minute even under load.
 */
let cachedDebugFlag: { value: boolean; expiresAt: number } | undefined;
const DEBUG_FLAG_CACHE_TTL_MS = 30_000;

/**
 * Test-only: reset the debug-flag cache. Call from `beforeEach` so
 * test cases that mock different config-flag values aren't blocked
 * by a stale cached value from a prior test in the same suite.
 * Production code should never call this — the TTL handles
 * invalidation under normal usage.
 */
export function _resetIsPlanModeDebugEnabledCacheForTests(): void {
  cachedDebugFlag = undefined;
}

export function isPlanModeDebugEnabled(): boolean {
  if (process.env.OPENCLAW_DEBUG_PLAN_MODE === "1") {
    return true;
  }
  const now = Date.now();
  if (cachedDebugFlag && cachedDebugFlag.expiresAt > now) {
    return cachedDebugFlag.value;
  }
  let value = false;
  try {
    const cfg = loadConfig();
    value = cfg?.agents?.defaults?.planMode?.debug === true;
  } catch {
    value = false;
  }
  cachedDebugFlag = { value, expiresAt: now + DEBUG_FLAG_CACHE_TTL_MS };
  return value;
}

/**
 * Emit a plan-mode debug event. No-op when `OPENCLAW_DEBUG_PLAN_MODE`
 * is unset. The event's `kind` becomes part of the message tag so
 * callers can grep `[plan-mode/state_transition]`, etc.
 */
export function logPlanModeDebug(event: PlanModeDebugEvent): void {
  if (!isDebugEnabled()) {
    return;
  }
  const { kind, ...meta } = event;
  logger.debug(`[plan-mode/${kind}]`, meta as Record<string, unknown>);
}
