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
export type PlanModeDebugEvent =
  | {
      kind: "state_transition";
      sessionKey: string;
      from: string;
      to: string;
      trigger: string;
    }
  | {
      kind: "gate_decision";
      sessionKey: string;
      tool: string;
      allowed: boolean;
      planMode: string | undefined;
      reason?: string;
    }
  | {
      kind: "tool_call";
      sessionKey: string;
      tool: "enter_plan_mode" | "exit_plan_mode" | "update_plan";
      runId: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "synthetic_injection";
      sessionKey: string;
      tag: string;
      preview: string;
    }
  | {
      kind: "nudge_event";
      sessionKey: string;
      nudgeId: string;
      phase: "scheduled" | "fired" | "cleaned";
    }
  | {
      kind: "subagent_event";
      sessionKey: string;
      parentRunId: string;
      childRunId: string;
      event: "spawn" | "return";
    }
  | {
      kind: "approval_event";
      sessionKey: string;
      action: string;
      openSubagentCount: number;
      result: "accepted" | "rejected_by_subagent_gate" | "other";
    }
  | {
      kind: "toast_event";
      sessionKey: string;
      toast: string;
      phase: "fired" | "dismissed";
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
  if (process.env.OPENCLAW_DEBUG_PLAN_MODE === "1") {
    return true;
  }
  try {
    const cfg = loadConfig();
    return cfg?.agents?.defaults?.planMode?.debug === true;
  } catch {
    return false;
  }
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
