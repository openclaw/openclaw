import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";

export function createSubagentManagerTestOptions(
  runs: SubagentManagerOptions["runs"],
  callGateway: SubagentManagerOptions["callGateway"],
): SubagentManagerOptions {
  return {
    runs,
    callGateway,
    getChildSessionCandidates: (key) =>
      [...runs.values()].filter((row) => row.childSessionKey === key),
    getRunsForChildSession: (key) =>
      [...runs.values()].filter((row) => row.childSessionKey === key),
    resumedRuns: new Set(),
    acquireTerminalCompletionLock: async () => () => {},
    getRuntimeConfig: () => ({}),
    ensureListener: () => {},
    startSweeper: () => {},
    stopSweeper: () => {},
    resumeSubagentRun: () => {},
    clearPendingLifecycleError: () => {},
    clearPendingLifecycleTimeout: () => {},
    resolveSubagentWaitTimeoutMs: () => 100,
    scheduleSweep: () => {},
    resolveSubagentSessionCompletion: async () => null,
    resolveSubagentSessionStartedAt: async () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: async () => {},
    completeSubagentRun: async () => {},
  };
}
