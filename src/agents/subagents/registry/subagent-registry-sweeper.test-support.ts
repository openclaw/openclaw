import { onTestFinished, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import * as subagentMemory from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

type SweeperOptions = Parameters<typeof createSubagentRegistrySweeper>[0];

export function createSubagentSweeperRun(): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    childSessionIdentity: { sessionId: "session-id", lifecycleRevision: "session-revision" },
    task: "recover after restart",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
}

export function mockSubagentSweeperChildLookup(runs: Map<string, SubagentRunRecord>) {
  return vi
    .spyOn(subagentMemory, "getSubagentRunsForChildSession")
    .mockImplementation((childSessionKey) =>
      [...runs.values()].filter((entry) => entry.childSessionKey === childSessionKey),
    );
}

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
  runs = new Map<string, SubagentRunRecord>(),
) {
  runs.set(entry.runId, entry);
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
          return { writeId: write.writeId, notices: [] } as never;
        },
      });
    });
  const callbacks = {
    completeCleanupBookkeeping: vi.fn<SweeperOptions["completeCleanupBookkeeping"]>(
      async ({ runId, entry: expectedEntry, isCurrent = () => true, finalizeDelivery }) => {
        if (!isCurrent()) {
          return;
        }
        await mutateSubagentRuns(
          [runId],
          (rows) => {
            const current = rows.get(runId);
            if (!current || !isSameSubagentRunOwner(current, expectedEntry) || !isCurrent()) {
              return { value: undefined };
            }
            const draft = structuredClone(current);
            finalizeDelivery?.(draft);
            return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
          },
          { runs },
        );
      },
    ),
    finalizeInterruptedSubagentRun: vi.fn<SweeperOptions["finalizeInterruptedSubagentRun"]>(
      async () => 0,
    ),
    completeSubagentRunWithRecovery: vi.fn(),
    discardTerminalDelivery: vi.fn<SweeperOptions["discardTerminalDelivery"]>(),
    emitSubagentEndedHookForRun: vi.fn(),
    notifyContextEngineSubagentEnded: vi.fn(),
    runContextEngineSubagentEnded: vi.fn(),
    callGateway: vi.fn(),
    warn: vi.fn(),
    startSubagentAnnounceCleanupFlow: vi.fn(() => true),
    resumeRequesterSettleWake: vi.fn(),
  };
  const childLookup = mockSubagentSweeperChildLookup(runs);
  const collectorLookup: SweeperOptions["getRunsForCollectorGroup"] = (
    requesterSessionKey,
    groupId,
  ) =>
    [...runs].filter(
      ([, candidate]) =>
        candidate.collect &&
        candidate.groupId === groupId &&
        (candidate.swarmRequesterSessionKey ?? candidate.requesterSessionKey) ===
          requesterSessionKey,
    );
  const sweeper = createSubagentRegistrySweeper({
    ...callbacks,
    runs,
    resumedRuns: new Set(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    getGatewayRecoveryRuntime: () => runtime.current,
    resumePendingRequesterSettlements: () => false,
    isCleanupOwnerCurrent: (selected) =>
      isSameSubagentRunOwner(runs.get(selected.runId), selected) || !runs.has(selected.runId),
    isTerminalTailActive: () => false,
    sessionEffectsHostCurrent: (selected) => selected.execution.suppressSessionEffects !== true,
    shouldSuppressSessionEffects: async (selected) =>
      selected.execution.suppressSessionEffects === true,
    shouldEmitEndedHookForRun: vi.fn(() => false),
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    retireSupersededRun: vi.fn(),
    retireObligations: vi.fn(async () => {}),
    getRunsForChildSession: childLookup,
    getRunsForCollectorGroup: collectorLookup,
  });
  onTestFinished(async () => {
    await sweeper.reset();
    childLookup.mockRestore();
    worker.mockRestore();
  });
  return { ...callbacks, entry, runs, sweeper };
}
