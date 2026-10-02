import { onTestFinished, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import { subagentRunRowVersion } from "./subagent-registry.store.row.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

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
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation(async (owner, run, options) => {
      options?.assertCurrent?.();
      return run({
        execute: async (command, executeOptions) => {
          if (command.type !== "subagents.persistChanges") {
            return execute(owner, (scope) => scope.execute(command, executeOptions), options);
          }
          // Scheduling tests exercise publication through the real owner; native CAS has worker coverage.
          const write = command.input as SubagentRegistryWrite;
          return {
            writeId: write.writeId,
            notices: [],
            versions: new Map([
              ...write.values.map((row) => [row.run_id, subagentRunRowVersion(row)] as const),
              ...write.deleteRunIds.map((id) => [id, null] as const),
            ]),
          } as never;
        },
      });
    });
  const finalizeInterruptedSubagentRun = vi.fn(
    async (_params: {
      runId: string;
      expectedEntry?: SubagentRunRecord;
      error: string;
      endedAt?: number;
    }) => 0,
  );
  const completeSubagentRunWithRecovery = vi.fn();
  const completeCleanupBookkeeping = vi.fn<
    Parameters<typeof createSubagentRegistrySweeper>[0]["completeCleanupBookkeeping"]
  >(async (params) => {
    if (params.isCurrent && !params.isCurrent()) {
      return;
    }
    await mutateSubagentRuns(
      [params.runId],
      (rows) => {
        const current = rows.get(params.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, params.entry) ||
          params.isCurrent?.() === false
        ) {
          return { value: undefined };
        }
        const draft = structuredClone(current);
        params.discardDelivery?.(draft);
        return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
      },
      { runs },
    );
  });
  const discardTerminalDelivery =
    vi.fn<Parameters<typeof createSubagentRegistrySweeper>[0]["discardTerminalDelivery"]>();
  const emitSubagentEndedHookForRun = vi.fn();
  const notifyContextEngineSubagentEnded = vi.fn();
  const runContextEngineSubagentEnded = vi.fn();
  const callGateway = vi.fn();
  const resumeRequesterSettleWake = vi.fn();
  const warn = vi.fn();
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery,
    getGatewayRecoveryRuntime: () => runtime.current,
    finalizeInterruptedSubagentRun,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow: vi.fn(() => true),
    completeCleanupBookkeeping,
    isEndedHookOwnerCurrent: (runId, selected) =>
      isSameSubagentRunOwner(runs.get(runId), selected) || !runs.has(runId),
    sessionEffectsHostCurrent: (selected) => selected.execution.suppressSessionEffects !== true,
    shouldSuppressSessionEffects: async (selected) =>
      selected.execution.suppressSessionEffects === true,
    discardTerminalDelivery,
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun,
    callGateway,
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded,
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
  onTestFinished(async () => {
    await sweeper.reset();
    worker.mockRestore();
  });
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
    runContextEngineSubagentEnded,
    sweeper,
    warn,
  };
}
