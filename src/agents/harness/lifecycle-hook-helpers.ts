/**
 * Agent harness lifecycle hook helpers.
 *
 * This module dispatches LLM/agent lifecycle plugin hooks and normalizes
 * before-finalize retry/finalize decisions with bounded retry accounting.
 */
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBlockMessage } from "../../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforeAgentRunEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";
import type { VoidHookRunOptions } from "../../plugins/hooks.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");
const FINALIZE_RETRY_BUDGET_KEY = Symbol.for("openclaw.pluginFinalizeRetryBudget");
const FINALIZE_RETRY_BUDGET_MAX_ENTRIES = 2048;

type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;
type FinalizeRetryBudget = Map<string, Map<string, number>>;

/** Returns the current global hook runner for harness lifecycle hooks. */
export function getAgentHarnessHookRunner(): AgentHarnessHookRunner {
  return getGlobalHookRunner();
}

function getFinalizeRetryBudget(): FinalizeRetryBudget {
  return resolveGlobalSingleton<FinalizeRetryBudget>(FINALIZE_RETRY_BUDGET_KEY, () => new Map());
}

function countFinalizeRetryBudgetEntries(budget: FinalizeRetryBudget): number {
  let count = 0;
  for (const runBudget of budget.values()) {
    count += runBudget.size;
  }
  return count;
}

function pruneFinalizeRetryBudget(budget: FinalizeRetryBudget): void {
  while (countFinalizeRetryBudgetEntries(budget) > FINALIZE_RETRY_BUDGET_MAX_ENTRIES) {
    const oldestRunId = budget.keys().next().value;
    if (oldestRunId === undefined) {
      return;
    }
    const oldestRunBudget = budget.get(oldestRunId);
    const oldestRetryKey = oldestRunBudget?.keys().next().value;
    if (oldestRunBudget && oldestRetryKey !== undefined) {
      oldestRunBudget.delete(oldestRetryKey);
    }
    if (!oldestRunBudget || oldestRunBudget.size === 0) {
      budget.delete(oldestRunId);
    }
  }
}

function buildFinalizeRetryInstructionKey(instruction: string): string {
  return `instruction:${createHash("sha256").update(instruction).digest("hex")}`;
}

/** Dispatches best-effort LLM input hooks for a harness attempt. */
export function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_input") || typeof hookRunner.runLlmInput !== "function") {
    return;
  }
  void hookRunner
    .runLlmInput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_input hook failed: ${String(error)}`);
    });
}

/** Normalized before_agent_run admission decision for one harness attempt. */
export type AgentHarnessBeforeAgentRunOutcome =
  | { outcome: "pass" }
  | { outcome: "block"; blockedBy: string; message: string };

const BEFORE_AGENT_RUN_INCOMPATIBLE_BLOCK = {
  outcome: "block" as const,
  reason: "before_agent_run hook runner is incompatible",
};
const BEFORE_AGENT_RUN_FAILED_BLOCK = {
  outcome: "block" as const,
  reason: "before_agent_run hook failed",
};

/**
 * Runs the fail-closed before_agent_run admission gate for one plugin-owned
 * harness attempt (e.g. a native Codex turn). Callers must invoke this exactly
 * once per attempt, before any diagnostics, llm_input, or model/native start,
 * and must not start a model when the result is undetermined. Hook errors,
 * timeouts, and malformed decisions all resolve to `block` so the caller fails
 * closed instead of guessing.
 *
 * Compatibility: `hasHooks("before_agent_run")` and `runBeforeAgentRun` are
 * reported independently so this helper can support hook-runner shapes older
 * than the one that introduced this gate. When no `before_agent_run` hook is
 * registered at all, this resolves `pass` without calling the runner. But when
 * a hook *is* registered and the runner cannot execute it (an older or
 * partial runner that advertises the hook without a callable
 * `runBeforeAgentRun`), this fails closed rather than silently admitting an
 * attempt a registered policy never got to see. Only the "nothing is
 * registered" case is treated as compatible pass-through; "registered but
 * unrunnable" is always a block. Any drift in the runner's shape (a new
 * OpenClaw core/plugin dependency set, not just a harness-side package) must
 * go through the project's compatibility review before it ships, since this
 * helper cannot distinguish an intentionally-absent gate from a broken one.
 */
export async function runAgentHarnessBeforeAgentRun(params: {
  event: PluginHookBeforeAgentRunEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentRunOutcome> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_agent_run")) {
    return { outcome: "pass" };
  }
  if (typeof hookRunner.runBeforeAgentRun !== "function") {
    // A before_agent_run policy is registered, but this runner cannot execute
    // it. Do not fall back to pass-through: that would let a real registered
    // gate silently never run.
    log.warn("before_agent_run hooks are registered but the hook runner cannot execute them");
    const blockedBy = "before_agent_run";
    return {
      outcome: "block",
      blockedBy,
      message: resolveBlockMessage(BEFORE_AGENT_RUN_INCOMPATIBLE_BLOCK, { blockedBy }),
    };
  }
  try {
    const result = await hookRunner.runBeforeAgentRun(
      params.event,
      buildAgentHookContext(params.ctx),
    );
    const decision = result?.decision;
    if (decision?.outcome !== "block") {
      return { outcome: "pass" };
    }
    const blockedBy = result?.pluginId ?? "unknown";
    return { outcome: "block", blockedBy, message: resolveBlockMessage(decision, { blockedBy }) };
  } catch {
    // Hook exceptions may carry plugin-local or user-provided detail (prompt
    // fragments, policy internals). Log only a fixed, safe message; never the
    // exception text itself.
    log.warn("before_agent_run hook failed; blocking request");
    const blockedBy = "before_agent_run";
    return {
      outcome: "block",
      blockedBy,
      message: resolveBlockMessage(BEFORE_AGENT_RUN_FAILED_BLOCK, { blockedBy }),
    };
  }
}

/** Dispatches best-effort LLM output hooks for a harness attempt. */
export function runAgentHarnessLlmOutputHook(params: {
  event: PluginHookLlmOutputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_output") || typeof hookRunner.runLlmOutput !== "function") {
    return;
  }
  void hookRunner
    .runLlmOutput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_output hook failed: ${String(error)}`);
    });
}

async function executeAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
  unrefTimeout?: boolean;
}): Promise<void> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end") || typeof hookRunner.runAgentEnd !== "function") {
    return;
  }
  try {
    const options: VoidHookRunOptions = { unrefTimeout: params.unrefTimeout ?? false };
    await hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx), options);
  } catch (error) {
    log.warn(`agent_end hook failed: ${String(error)}`);
  }
}

/** Starts agent_end hooks with unref timeout behavior. */
export function runAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  void executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: true });
}

/** Runs agent_end hooks and waits for completion. */
export async function awaitAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<void> {
  await executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: false });
}

/** Normalized before-finalize hook decision consumed by harness loops. */
type AgentHarnessBeforeAgentFinalizeOutcome =
  | { action: "continue" }
  | { action: "revise"; reason: string }
  | { action: "finalize"; reason?: string };

/** Runs before-finalize hooks and normalizes finalize/revise/continue decisions. */
export async function runAgentHarnessBeforeAgentFinalizeHook(params: {
  event: PluginHookBeforeAgentFinalizeEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentFinalizeOutcome> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (
    !hookRunner?.hasHooks("before_agent_finalize") ||
    typeof hookRunner.runBeforeAgentFinalize !== "function"
  ) {
    return { action: "continue" };
  }
  try {
    const eventForNormalization: PluginHookBeforeAgentFinalizeEvent = {
      ...params.event,
      runId: params.event.runId ?? params.ctx.runId,
    };
    return normalizeBeforeAgentFinalizeResult(
      await hookRunner.runBeforeAgentFinalize(
        eventForNormalization,
        buildAgentHookContext(params.ctx),
      ),
      eventForNormalization,
    );
  } catch (error) {
    log.warn(`before_agent_finalize hook failed: ${String(error)}`);
    return { action: "continue" };
  }
}

function normalizeBeforeAgentFinalizeResult(
  result: PluginHookBeforeAgentFinalizeResult | undefined,
  event?: PluginHookBeforeAgentFinalizeEvent,
): AgentHarnessBeforeAgentFinalizeOutcome {
  if (result?.action === "finalize") {
    const reason = normalizeTrimmedString(result.reason);
    return reason ? { action: "finalize", reason } : { action: "finalize" };
  }
  if (result?.action === "revise") {
    const retryCandidates = readBeforeAgentFinalizeRetryCandidates(result);
    if (retryCandidates.length > 0) {
      const reason = normalizeTrimmedString(result.reason);
      for (const retry of retryCandidates) {
        const retryInstruction = normalizeTrimmedString(retry.instruction);
        if (!retryInstruction) {
          continue;
        }
        const maxAttempts =
          typeof retry.maxAttempts === "number" && Number.isFinite(retry.maxAttempts)
            ? Math.max(1, Math.floor(retry.maxAttempts))
            : 1;
        const retryRunId = event?.runId ?? event?.sessionId ?? "unknown-run";
        const retryKey =
          normalizeTrimmedString(retry.idempotencyKey) ||
          buildFinalizeRetryInstructionKey(retryInstruction);
        // Track retry attempts per run+instruction to prevent finalize hooks
        // from creating an unbounded revise loop.
        const budget = getFinalizeRetryBudget();
        const runBudget = budget.get(retryRunId) ?? new Map<string, number>();
        const nextCount = (runBudget.get(retryKey) ?? 0) + 1;
        runBudget.delete(retryKey);
        runBudget.set(retryKey, nextCount);
        budget.delete(retryRunId);
        budget.set(retryRunId, runBudget);
        pruneFinalizeRetryBudget(budget);
        if (nextCount > maxAttempts) {
          continue;
        }
        const revisedReason =
          reason && reason.includes(retryInstruction)
            ? reason
            : [reason, retryInstruction].filter(Boolean).join("\n\n");
        return { action: "revise", reason: revisedReason };
      }
      return { action: "continue" };
    }
    const reason = normalizeTrimmedString(result.reason);
    return reason ? { action: "revise", reason } : { action: "continue" };
  }
  return { action: "continue" };
}

function readBeforeAgentFinalizeRetryCandidates(
  result: PluginHookBeforeAgentFinalizeResult,
): NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]>[] {
  const candidateList = (
    result as {
      retryCandidates?: unknown;
    }
  ).retryCandidates;
  if (Array.isArray(candidateList) && candidateList.length > 0) {
    return candidateList.filter(isBeforeAgentFinalizeRetry);
  }
  return isBeforeAgentFinalizeRetry(result.retry) ? [result.retry] : [];
}

function isBeforeAgentFinalizeRetry(
  value: unknown,
): value is NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]> {
  return isRecord(value);
}
