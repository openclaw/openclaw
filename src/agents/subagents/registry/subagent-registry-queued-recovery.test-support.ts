import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";

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

export function createRegistrationFixture() {
  const refusal = { descriptor: true, terminal: false };
  probe.command(stateWorker, async (command, executeOptions, scope) => {
    if (isSubagentRegistryWriteCommand(command)) {
      const rows = command.input.values.map(rowToSubagentRunRecord);
      if (refusal.descriptor && rows.some((row) => row?.queuedLaunch)) {
        throw new Error("descriptor refused");
      }
      if (refusal.terminal && rows.some((row) => row?.execution.status === "terminal")) {
        throw new Error("terminal settlement refused");
      }
    }
    return scope.execute(command, executeOptions);
  });
  const options = createSubagentManagerTestOptions(subagentRuns, async () => {
    throw new Error("Unexpected registration Gateway call");
  });
  const manager = createSubagentRunManager(options);
  return { refusal, manager };
}
