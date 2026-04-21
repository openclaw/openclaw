import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  /**
   * Optional task override for the replacement run.  Callers that dispatched a
   * new message (steer, descendant wake, orphan resume) should pass the text
   * actually sent so that restart-redispatch reconstructs the correct prompt
   * after a gateway crash.  When omitted, the previous run's `task` is carried
   * over untouched.
   */
  task?: string;
};

type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;

export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
}

export function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}
