import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function defineRetainedArchivePublicationCases(params: {
  getRegistry: () => typeof import("./subagent-registry.test-helpers.js");
  addCanonicalSubagentRunForTests: (
    entry: Parameters<
      (typeof import("./subagent-registry.test-helpers.js"))["addSubagentRunForTests"]
    >[0],
  ) => ReturnType<(typeof import("./subagent-registry.test-helpers.js"))["addSubagentRunForTests"]>;
  sweepAndSettleCleanup: () => Promise<void>;
  settleRootWork: (keepObserving?: boolean) => Promise<void>;
}) {
  const { addCanonicalSubagentRunForTests, sweepAndSettleCleanup, settleRootWork } = params;
  it("stabilizes provisional killed tasks before deleting expired tombstones", async () => {
    const mod = params.getRegistry();
    const now = Date.now();
    const runId = "run-killed-tombstone-expired";
    const childSessionKey = "agent:main:subagent:killed-tombstone-expired";
    const target = {
      sessionId: "session-killed-tombstone-expired",
      lifecycleRevision: "lifecycle-killed-tombstone-expired",
    };
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      startedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
      // Recovery keeps the physical target captured by the original cleanup owner.
      deleteCleanupTarget: target,
    });

    // The first pass stabilizes canonical cancellation and joins its detached cleanup.
    await sweepAndSettleCleanup();
    const stable = subagentRuns.get(runId);
    expect(stable).toMatchObject({
      archiveAtMs: now,
      cleanupHandled: true,
      cleanupCompletedAt: now,
      endedReason: "subagent-killed",
      execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      deleteCleanupTarget: target,
      deleteCleanupDispatchedAt: now,
    });
    expect(stable?.killReconciliation).toBeUndefined();
    expect(stable?.requesterSettleWake).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      archiveAtMs: now,
      cleanupCompletedAt: now,
      endedReason: "subagent-killed",
      execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      deleteCleanupTarget: target,
    });
    expect(vi.mocked(callGateway)).toHaveBeenCalledWith({
      assertDispatchCurrent: expect.any(Function),
      prepareDispatchCurrent: expect.any(Function),
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: target.lifecycleRevision,
      },
      timeoutMs: 10_000,
    });
    expect(
      vi.mocked(callGateway).mock.calls.filter(([request]) => request.method === "sessions.delete"),
    ).toHaveLength(1);

    // The next archive pass owns its real SQLite DELETE through host acknowledgement.
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (
                  command.type === "subagents.persistChanges" &&
                  (command.input as SubagentRegistryWrite).deleteRunIds.includes(runId)
                ) {
                  entered.resolve();
                  await release.promise;
                }
                return result;
              },
            }),
          options,
        ),
      );
    const archival = sweepAndSettleCleanup();
    try {
      await Promise.race([
        entered.promise,
        archival.then(() => {
          throw new Error("Archive omitted its native DELETE acknowledgement boundary");
        }),
      ]);
      expect(subagentRuns.get(runId)).toBe(stable);
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
      expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      release.resolve();
      await archival;
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
      expect(subagentRuns.has(runId)).toBe(false);
      expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      expect(
        vi
          .mocked(callGateway)
          .mock.calls.filter(([request]) => request.method === "sessions.delete"),
      ).toHaveLength(1);
    } finally {
      release.resolve();
      try {
        await archival;
      } finally {
        writer.mockRestore();
      }
    }
  });

  it("retains cancellation evidence when the retirement write is rejected", async () => {
    const mod = params.getRegistry();
    const now = Date.now();
    const runId = "run-killed-tombstone-retry";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:killed-tombstone-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });
    await mutateSubagentRuns([runId], (rows) => {
      const entry = rows.get(runId)!;
      return {
        value: undefined,
        postimages: new Map([
          [
            runId,
            {
              ...entry,
              execution: { ...entry.execution, suppressSessionEffects: true },
            },
          ],
        ]),
      };
    });
    // Stabilization commits cancellation and completes cleanup, but does not remove the row.
    await sweepAndSettleCleanup();
    const stable = subagentRuns.get(runId);
    const stableNative = loadSubagentRegistryFromSqlite().get(runId);
    expect(stable).toMatchObject({
      archiveAtMs: now,
      cleanupHandled: true,
      cleanupCompletedAt: now,
      endedReason: "subagent-killed",
      execution: {
        status: "terminal",
        outcome: { status: "error", error: "manual kill" },
        suppressSessionEffects: true,
      },
    });
    expect(stable?.killReconciliation).toBeUndefined();
    expect(stable?.requesterSettleWake).toBeUndefined();
    expect(stableNative).toMatchObject({
      archiveAtMs: now,
      cleanupCompletedAt: now,
      endedReason: "subagent-killed",
      execution: {
        status: "terminal",
        outcome: { status: "error", error: "manual kill" },
        suppressSessionEffects: true,
      },
    });
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    let rejectedWrites = 0;
    let refusedPreimage: SubagentRunRecord | undefined;
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                if (
                  command.type === "subagents.persistChanges" &&
                  (command.input as SubagentRegistryWrite).deleteRunIds.includes(runId)
                ) {
                  rejectedWrites += 1;
                  refusedPreimage = subagentRuns.get(runId);
                  throw new Error("retirement write rejected");
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    try {
      await expect(mod.testing.sweepOnceForTests()).rejects.toMatchObject({
        name: "SubagentRegistryWriteError",
        outcome: "not-committed",
        cause: expect.objectContaining({ message: "retirement write rejected" }),
      });
      await settleRootWork(true);
      expect(rejectedWrites).toBe(1);
      expect(refusedPreimage).toBe(stable);
      expect(subagentRuns.get(runId)).toBe(stable);
      expect(loadSubagentRegistryFromSqlite().get(runId)).toEqual(stableNative);
      expect(
        vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
    } finally {
      writer.mockRestore();
    }
    // The refused native DELETE leaves the same archive owner retryable without reopening cleanup.
    await sweepAndSettleCleanup();
    expect(subagentRuns.has(runId)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
    expect(
      vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
  });
}
