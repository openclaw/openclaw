import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CodeModeActivityOwner } from "../../code-mode-activity.js";
import type { CodeModeStats } from "../../code-mode-stats.js";
import type { AgentSubmissionObserver } from "../../sessions/agent-session-accounting.js";
import type { NormalizedUsage } from "../../usage.js";
import type { ToolSummaryTrace } from "../types.js";

export type EmbeddedRunAccountingObservation = {
  provider: string;
  model: string;
  config?: OpenClawConfig;
  agentDir?: string;
  usage?: NormalizedUsage;
  assistantTurns?: number;
  assistantTurnsObserved: boolean;
  toolSummary?: ToolSummaryTrace;
  toolsObserved: boolean;
  codeModeEngaged?: boolean;
  codeModeStats?: CodeModeStats;
  codeModeLifecycleObserved: boolean;
};

export type EmbeddedRunOpaqueWorkReason =
  | "acp_runtime"
  | "settled_finalization_failed"
  | "session_core_compaction"
  | "session_extension_compaction"
  | "context_engine_llm_complete"
  | "deferred_context_engine_maintenance"
  | "post_turn_compaction"
  | "exec_auto_review_model_completion";

type EmbeddedRunAccountingObservers = {
  readonly codeModeActivityOwner?: CodeModeActivityOwner;
  allocateDiagnosticModelCallId?: () => string;
  onAgentSubmission?: AgentSubmissionObserver;
  onAttemptObserved?: (observation: EmbeddedRunAccountingObservation) => void;
  onRuntimeSelected?: (runtime: "embedded" | "native") => void;
  onOpaqueWork?: (reason: EmbeddedRunOpaqueWorkReason) => void;
};

const observers = new WeakMap<object, EmbeddedRunAccountingObservers>();

export function bindEmbeddedRunAccountingObservers<T extends object>(
  target: T,
  value: EmbeddedRunAccountingObservers | undefined,
): T {
  if (
    value?.codeModeActivityOwner ||
    value?.allocateDiagnosticModelCallId ||
    value?.onAgentSubmission ||
    value?.onAttemptObserved ||
    value?.onRuntimeSelected ||
    value?.onOpaqueWork
  ) {
    observers.set(target, value);
  }
  return target;
}

export function copyEmbeddedRunAccountingObservers<T extends object>(source: object, target: T): T {
  return bindEmbeddedRunAccountingObservers(target, observers.get(source));
}

export function resolveEmbeddedRunAccountingObservers(
  target: object,
): EmbeddedRunAccountingObservers | undefined {
  return observers.get(target);
}

export function markContextEngineLlmCompleteInvocation(target: object): void {
  observers.get(target)?.onOpaqueWork?.("context_engine_llm_complete");
}
