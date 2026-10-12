import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { forgetPromptBuildDrainCacheForRun } from "../plugin-turn-context.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";
import { takeHookMessageLoader } from "./lifecycle-hook-messages.js";

const log = createSubsystemLogger("agents/harness");
const FINALIZE_RETRY_BUDGET_KEY = Symbol.for("openclaw.pluginFinalizeRetryBudget");
const FINALIZE_RETRY_BUDGET_MAX_ENTRIES = 2048;

type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;
type AgentHarnessHookParams<Event> = {
  event: Event;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
};
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
    const [oldestRunId, oldestRunBudget] = budget.entries().next().value!;
    const oldestRetryKey = oldestRunBudget.keys().next().value;
    if (oldestRetryKey !== undefined) {
      oldestRunBudget.delete(oldestRetryKey);
    }
    if (oldestRunBudget.size === 0) {
      budget.delete(oldestRunId);
    }
  }
}

/** Dispatches best-effort LLM input hooks for a harness attempt. */
export function runAgentHarnessLlmInputHook(
  params: AgentHarnessHookParams<PluginHookLlmInputEvent>,
): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_input")) {
    return;
  }
  void hookRunner
    .runLlmInput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_input hook failed: ${String(error)}`);
    });
}

/** Dispatches best-effort LLM output hooks for a harness attempt. */
export function runAgentHarnessLlmOutputHook(
  params: AgentHarnessHookParams<PluginHookLlmOutputEvent>,
): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_output")) {
    return;
  }
  void hookRunner
    .runLlmOutput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_output hook failed: ${String(error)}`);
    });
}

async function executeAgentHarnessAgentEndHook(
  params: AgentHarnessHookParams<PluginHookAgentEndEvent> & { unrefTimeout?: boolean },
): Promise<void> {
  forgetPromptBuildDrainCacheForRun(params.ctx.runId);
  const loadMessages = takeHookMessageLoader(params.event);
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end")) {
    return;
  }
  try {
    const event = loadMessages ? { ...params.event, messages: await loadMessages() } : params.event;
    await hookRunner.runAgentEnd(event, buildAgentHookContext(params.ctx), {
      unrefTimeout: params.unrefTimeout ?? false,
    });
  } catch (error) {
    log.warn(`agent_end hook failed: ${String(error)}`);
  }
}

/** Starts agent_end hooks with unref timeout behavior. */
export function runAgentHarnessAgentEndHook(
  params: AgentHarnessHookParams<PluginHookAgentEndEvent>,
): void {
  void executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: true });
}

/** Runs agent_end hooks and waits for completion. */
export async function awaitAgentHarnessAgentEndHook(
  params: AgentHarnessHookParams<PluginHookAgentEndEvent>,
): Promise<void> {
  await executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: false });
}

/** Normalized before-finalize hook decision consumed by harness loops. */
type AgentHarnessBeforeAgentFinalizeOutcome =
  | { action: "continue" }
  | { action: "revise"; reason: string }
  | { action: "finalize"; reason?: string };

/** Runs before-finalize hooks and normalizes finalize/revise/continue decisions. */
export async function runAgentHarnessBeforeAgentFinalizeHook(
  params: AgentHarnessHookParams<PluginHookBeforeAgentFinalizeEvent>,
): Promise<AgentHarnessBeforeAgentFinalizeOutcome> {
  const loadMessages = takeHookMessageLoader(params.event);
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_agent_finalize")) {
    return { action: "continue" };
  }
  try {
    const eventForNormalization: PluginHookBeforeAgentFinalizeEvent = {
      ...params.event,
      runId: params.event.runId ?? params.ctx.runId,
      ...(loadMessages ? { messages: await loadMessages() } : {}),
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
  if (result?.action !== "revise") {
    return { action: "continue" };
  }
  const retryCandidates = readBeforeAgentFinalizeRetryCandidates(result);
  const reason = normalizeTrimmedString(result.reason);
  if (retryCandidates.length === 0) {
    return reason ? { action: "revise", reason } : { action: "continue" };
  }
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
      `instruction:${createHash("sha256").update(retryInstruction).digest("hex")}`;
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
