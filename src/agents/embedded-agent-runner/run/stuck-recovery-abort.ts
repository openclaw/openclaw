export type StuckRecoveryAbortClassification =
  | "model_idle_timeout"
  | "tool_execution_timeout"
  | "external_abort";

export function classifyStuckRecoveryAbort(params: {
  modelCallStarted: boolean;
  activePotentialSideEffectToolExecutions: number;
}): StuckRecoveryAbortClassification {
  if (params.activePotentialSideEffectToolExecutions > 0) {
    return "tool_execution_timeout";
  }
  if (params.modelCallStarted) {
    return "model_idle_timeout";
  }
  return "external_abort";
}
