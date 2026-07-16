type StuckRecoveryAbortClassification =
  | "model_idle_timeout"
  | "compaction_timeout"
  | "tool_execution_timeout"
  | "external_abort";

export function classifyStuckRecoveryAbort(params: {
  modelCallActive: boolean;
  compactionActive: boolean;
  activePotentialSideEffectToolExecutions: number;
}): StuckRecoveryAbortClassification {
  if (params.activePotentialSideEffectToolExecutions > 0) {
    return "tool_execution_timeout";
  }
  if (params.compactionActive) {
    return "compaction_timeout";
  }
  if (params.modelCallActive) {
    return "model_idle_timeout";
  }
  return "external_abort";
}
