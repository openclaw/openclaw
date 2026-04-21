/**
 * PR #68939 follow-up (P2.12b) — auto-inject plan-status preamble
 * into executing-mode turns.
 *
 * ## Why this exists
 *
 * `plan_mode_status` is a tool the agent CAN call to get ground-truth
 * plan state, but in practice GPT-5.4 rarely does — the approved plan
 * text is already in its context window (from the [PLAN_DECISION]:
 * approved injection) and the model's terseness training biases it
 * to not spend a tool call on info it believes it already has.
 *
 * Live-validated failure mode (2026-04-22, Eva investigation of
 * Baoyu flyer skills):
 *   - Eva did 4 of 6 steps' worth of work
 *   - Eva never called `update_plan` between those work chunks
 *   - At +1/+3/+5 nudge time, Eva returned NO_REPLY three times,
 *     claiming internally "all steps are marked complete"
 *   - `plan_mode_status` showed 1 in_progress + 3 pending + 2 completed
 *   - Agent had conflated "did the work" with "called update_plan on it"
 *
 * ## What this helper does
 *
 * On EVERY turn where the session has `planMode.mode === "executing"`,
 * `buildExecutionStatusInjection` returns a compact `[PLAN_STATUS]:`
 * block that:
 *   - reads the session from disk (bypassing the session-store cache
 *     so the preamble reflects writes from sibling turns/crons)
 *   - summarizes step counts + currently-in_progress step title
 *   - defers authority to `plan_mode_status` (the tool is the single
 *     source of truth; the preamble is a snapshot, not a substitute)
 *
 * The companion convenience wrapper `prependExecutionStatusIfExecuting`
 * handles both the lookup + the prepend so callers that just want
 * "new prompt string" can use it inline.
 *
 * ## Shared between user-reply AND cron paths
 *
 * P2.12b review (2026-04-22): the preamble composition is invoked
 * from TWO callers:
 *   - `src/auto-reply/reply/agent-runner-execution.ts` — user-reply
 *     path + heartbeat path (composed alongside the pending-injection
 *     queue).
 *   - `src/cron/isolated-agent/run-executor.ts` — cron-nudge path
 *     (prepended to `params.commandBody` before `executor.runPrompt`).
 * Both call sites MUST use this module's helpers; the shared
 * formatting is the whole point.
 *
 * ## Fail-open semantics
 *
 * Returns `undefined` when:
 *   - session isn't in executing mode (nothing to inject)
 *   - session store read fails (the turn proceeds without the
 *     preamble — better than failing the whole turn on a transient
 *     disk error)
 *   - no plan steps recorded (nothing meaningful to summarize)
 *
 * Any thrown exception is caught and logged via the module's
 * subsystem logger; the turn continues uninterrupted. This path is
 * optional enrichment, not a critical-path dependency.
 *
 * ## Side-effect note
 *
 * `loadSessionStore(..., { skipCache: true })` skips the cache READ
 * but `setSerializedSessionStore` runs unconditionally on every
 * load, touching process-global cache state. This is the established
 * pattern used by the mutation-gate + plan-mode-status tool (see
 * `loadSessionStore` in `src/config/sessions/store-load.ts`); flagging
 * here because the impact compounds on busy executing-mode sessions.
 */

import { loadConfig } from "../../config/io.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

const log = createSubsystemLogger("plan-status-injection");

/** Soft cap on strings embedded in the preamble (title, step label). */
const PREAMBLE_STRING_SOFT_CAP = 140;

/** Soft cap on the plan title (tighter than step labels). */
const PREAMBLE_TITLE_SOFT_CAP = 120;

export interface BuildExecutionStatusInjectionOptions {
  /**
   * Optional explicit store-path override. Used by tests to point at
   * a fixture path; production callers pass the already-resolved
   * storePath to avoid a second `loadConfig()` + `resolveStorePath`
   * round-trip (the agent-runner already has it in scope).
   */
  storePath?: string;
}

/**
 * Build the execution-phase `[PLAN_STATUS]:` preamble, or return
 * `undefined` if the preamble would be a no-op (not executing, no
 * steps, or disk read failed).
 *
 * See file-level docstring for the full contract.
 */
export async function buildExecutionStatusInjection(
  sessionKey: string,
  options?: BuildExecutionStatusInjectionOptions,
): Promise<string | undefined> {
  try {
    if (!sessionKey || sessionKey.trim().length === 0) {
      return undefined;
    }
    let storePath = options?.storePath;
    if (!storePath) {
      const cfg = loadConfig();
      const parsed = parseAgentSessionKey(sessionKey);
      storePath = resolveStorePath(
        cfg.session?.store,
        parsed?.agentId ? { agentId: parsed.agentId } : {},
      );
    }
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry: SessionEntry | undefined = store?.[sessionKey];
    if (!entry?.planMode) {
      return undefined;
    }
    const planMode = entry.planMode;
    if (planMode.mode !== "executing") {
      return undefined;
    }
    const steps = planMode.lastPlanSteps ?? [];
    if (steps.length === 0) {
      return undefined;
    }
    // Single-pass bucketed counts + "unknown" catch-all so hand-
    // edited stores or future status values don't silently drop
    // from the sum. An unknown bucket > 0 is logged at warn so an
    // operator investigating agent confusion has a trail.
    const counts = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
      unknown: 0,
    };
    for (const s of steps) {
      switch (s.status) {
        case "pending":
          counts.pending += 1;
          break;
        case "in_progress":
          counts.in_progress += 1;
          break;
        case "completed":
          counts.completed += 1;
          break;
        case "cancelled":
          counts.cancelled += 1;
          break;
        default:
          counts.unknown += 1;
      }
    }
    if (counts.unknown > 0) {
      log.warn(
        `preamble counted ${counts.unknown} step(s) with unrecognized status for sessionKey=${sessionKey}`,
      );
    }
    const inProgress = steps.find((s) => s.status === "in_progress");
    const title = truncate(planMode.title ?? "(untitled)", PREAMBLE_TITLE_SOFT_CAP);
    const inProgressStep = inProgress?.step;
    const inProgressLine =
      inProgressStep && inProgressStep.length > 0
        ? `\n  Current in_progress step: "${truncate(inProgressStep, PREAMBLE_STRING_SOFT_CAP)}"`
        : "";
    const preamble =
      `[PLAN_STATUS]: Executing approved plan "${title}". ` +
      `Steps: ${counts.completed}/${steps.length} completed, ` +
      `${counts.in_progress} in_progress, ${counts.pending} pending` +
      (counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : "") +
      (counts.unknown > 0 ? `, ${counts.unknown} unrecognized` : "") +
      `.${inProgressLine}\n  This snapshot is captured at turn-start and may be ` +
      "stale; `plan_mode_status` is authoritative if they disagree. Before " +
      "returning NO_REPLY, call `plan_mode_status` to verify, then call " +
      '`update_plan` to mark any finished step "completed" or "cancelled" ' +
      "based on what the tool reports. close-on-complete fires automatically " +
      "once pending=0 + in_progress=0.";
    log.debug(
      `preamble injected sessionKey=${sessionKey} steps=${steps.length} completed=${counts.completed} in_progress=${counts.in_progress} pending=${counts.pending}`,
    );
    return preamble;
  } catch (err) {
    log.warn(
      `buildExecutionStatusInjection failed sessionKey=${sessionKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Prepend the execution-phase `[PLAN_STATUS]:` preamble to `prompt`
 * if the session is in executing mode, or return `prompt` unchanged
 * otherwise. Shared by both the user-reply path and the cron-nudge
 * path (see file docstring on why both callers must use the same
 * formatting).
 */
export async function prependExecutionStatusIfExecuting(
  prompt: string,
  sessionKey: string,
  options?: BuildExecutionStatusInjectionOptions,
): Promise<string> {
  const prefix = await buildExecutionStatusInjection(sessionKey, options);
  if (!prefix) {
    return prompt;
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return prefix;
  }
  return `${prefix}\n\n${prompt}`;
}

/** Cap a string at `soft` chars with a trailing ellipsis. */
function truncate(text: string, soft: number): string {
  if (text.length <= soft) {
    return text;
  }
  return `${text.slice(0, Math.max(0, soft - 3))}...`;
}
