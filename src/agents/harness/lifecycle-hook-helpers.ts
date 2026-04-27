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
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");
const FINALIZE_RETRY_BUDGET_KEY = Symbol.for("openclaw.pluginFinalizeRetryBudget");
const FINALIZE_RETRY_BUDGET_MAX_ENTRIES = 2048;

type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;

function getFinalizeRetryBudget(): Map<string, number> {
  return resolveGlobalSingleton<Map<string, number>>(FINALIZE_RETRY_BUDGET_KEY, () => new Map());
}

function pruneFinalizeRetryBudget(budget: Map<string, number>): void {
  while (budget.size > FINALIZE_RETRY_BUDGET_MAX_ENTRIES) {
    const oldest = budget.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    budget.delete(oldest);
  }
}

export function clearAgentHarnessFinalizeRetryBudget(params?: { runId?: string }): void {
  const budget = getFinalizeRetryBudget();
  if (!params?.runId) {
    budget.clear();
    return;
  }
  const prefix = `${params.runId}:`;
  for (const key of [...budget.keys()]) {
    if (key.startsWith(prefix)) {
      budget.delete(key);
    }
  }
}

export function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_input") || typeof hookRunner.runLlmInput !== "function") {
    return;
  }
  void hookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`llm_input hook failed: ${String(error)}`);
  });
}

export function runAgentHarnessLlmOutputHook(params: {
  event: PluginHookLlmOutputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_output") || typeof hookRunner.runLlmOutput !== "function") {
    return;
  }
  void hookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`llm_output hook failed: ${String(error)}`);
  });
}

export function runAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end") || typeof hookRunner.runAgentEnd !== "function") {
    return;
  }
  void hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`agent_end hook failed: ${String(error)}`);
  });
}

export type AgentHarnessBeforeAgentFinalizeOutcome =
  | { action: "continue" }
  | { action: "revise"; reason: string }
  | { action: "finalize"; reason?: string };

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
    return normalizeBeforeAgentFinalizeResult(
      await hookRunner.runBeforeAgentFinalize(params.event, buildAgentHookContext(params.ctx)),
      params.event,
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
    return result.reason?.trim()
      ? { action: "finalize", reason: result.reason.trim() }
      : { action: "finalize" };
  }
  if (result?.action === "revise") {
    const retryInstruction = result.retry?.instruction?.trim();
    if (retryInstruction) {
      const maxAttempts =
        typeof result.retry?.maxAttempts === "number" && Number.isFinite(result.retry.maxAttempts)
          ? Math.max(1, Math.floor(result.retry.maxAttempts))
          : 1;
      const retryKey = [
        event?.runId ?? event?.sessionId ?? "unknown-run",
        result.retry?.idempotencyKey?.trim() || retryInstruction.slice(0, 160),
      ].join(":");
      const budget = getFinalizeRetryBudget();
      const nextCount = (budget.get(retryKey) ?? 0) + 1;
      budget.delete(retryKey);
      budget.set(retryKey, nextCount);
      pruneFinalizeRetryBudget(budget);
      if (nextCount > maxAttempts) {
        return { action: "continue" };
      }
      return { action: "revise", reason: retryInstruction };
    }
    const reason = result.reason?.trim();
    return reason ? { action: "revise", reason } : { action: "continue" };
  }
  return { action: "continue" };
}
