import { onTestFinished, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentSweeperRun(): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "recover after restart",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
}

export const createSubagentSweeperChildLookup =
  (runs: Map<string, SubagentRunRecord>) => (childSessionKey: string) =>
    [...runs.values()].filter((entry) => entry.childSessionKey === childSessionKey);

export function createArchivedSubagentSweeperRun(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return {
    ...createSubagentSweeperRun(),
    cleanup: "delete",
    archiveAtMs: Date.now() - 1,
    execution: { status: "terminal", endedAt: Date.now() - 10_000, outcome: { status: "ok" } },
    ...overrides,
  };
}

export function createSubagentSweeperHarness(
  runtime: { current?: GatewayRecoveryRuntime },
  entry = createSubagentSweeperRun(),
) {
  const runs = new Map([[entry.runId, entry]]);
  const finalizeInterruptedSubagentRun = vi.fn(
    async (_params: {
      runId: string;
      expectedEntry?: SubagentRunRecord;
      error: string;
      endedAt?: number;
    }) => 0,
  );
  const completeSubagentRunWithRecovery = vi.fn();
  const completeCleanupBookkeeping = vi.fn();
  const discardTerminalDelivery =
    vi.fn<Parameters<typeof createSubagentRegistrySweeper>[0]["discardTerminalDelivery"]>();
  const emitSubagentEndedHookForRun = vi.fn();
  const notifyContextEngineSubagentEnded = vi.fn();
  const callGateway = vi.fn();
  const resumeRequesterSettleWake = vi.fn();
  const startSubagentAnnounceCleanupFlow = vi.fn<
    Parameters<typeof createSubagentRegistrySweeper>[0]["startSubagentAnnounceCleanupFlow"]
  >(() => true);
  const warn = vi.fn();
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery,
    getGatewayRecoveryRuntime: () => runtime.current,
    finalizeInterruptedSubagentRun,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    completeCleanupBookkeeping,
    discardTerminalDelivery,
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun,
    callGateway,
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded,
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: createSubagentSweeperChildLookup(runs),
    getRunsForCollectorGroup: (requesterSessionKey, groupId) =>
      [...runs].filter(
        ([, candidate]) =>
          candidate.collect &&
          candidate.groupId === groupId &&
          (candidate.swarmRequesterSessionKey ?? candidate.requesterSessionKey) ===
            requesterSessionKey,
      ),
    warn,
  });
  onTestFinished(() => sweeper.reset());
  return {
    entry,
    runs,
    callGateway,
    completeCleanupBookkeeping,
    completeSubagentRunWithRecovery,
    discardTerminalDelivery,
    emitSubagentEndedHookForRun,
    finalizeInterruptedSubagentRun,
    notifyContextEngineSubagentEnded,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    sweeper,
    warn,
  };
}
