import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import * as internalSessionEffects from "../../internal-session-effects.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerArchiveCancellationTests({
  getRegistry,
  addCanonicalSubagentRunForTests,
  sweepAndSettleCleanup,
  waitForNoRequesterRuns,
}: {
  getRegistry: () => Pick<
    SubagentRegistryHarness,
    "listSubagentRunsForRequester" | "markSubagentRunTerminated" | "testing"
  >;
  addCanonicalSubagentRunForTests: (
    entry: Parameters<SubagentRegistryHarness["addSubagentRunForTests"]>[0],
  ) => Promise<void>;
  sweepAndSettleCleanup: () => Promise<void>;
  waitForNoRequesterRuns: () => Promise<void>;
}): void {
  it("stabilizes provisional killed tasks before deleting expired tombstones", async () => {
    const mod = getRegistry();
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-tombstone-expired",
      childSessionKey: "agent:main:subagent:killed-tombstone-expired",
      childSessionIdentity: {
        sessionId: "session-killed-tombstone-expired",
        lifecycleRevision: "lifecycle-killed-tombstone-expired",
      },
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
    });

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    expect(
      vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
  });

  it("retains cancellation evidence when the retirement write is rejected", async () => {
    const now = Date.now();
    const runId = "run-killed-tombstone-retry";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:killed-tombstone-retry",
      childSessionIdentity: {
        sessionId: "session-killed-tombstone-retry",
        lifecycleRevision: "lifecycle-killed-tombstone-retry",
      },
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
    let rejectedWrites = 0;
    let refusedPreimage: SubagentRunRecord | undefined;
    const writer = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (
        command.type === "subagents.persistChanges" &&
        (command.input as SubagentRegistryWrite).deleteRunIds.includes(runId)
      ) {
        rejectedWrites += 1;
        refusedPreimage = subagentRuns.get(runId);
        throw new Error("retirement write rejected");
      }
      return scope.execute(command, executeOptions);
    });
    try {
      await sweepAndSettleCleanup();
      expect(rejectedWrites).toBe(1);
      expect(refusedPreimage).toBeDefined();
      expect(refusedPreimage?.cleanupHandled).toBe(true);
      expect(subagentRuns.get(runId)).toEqual({ ...refusedPreimage, cleanupHandled: false });
      expect(subagentRuns.get(runId)).toMatchObject({
        endedReason: "subagent-killed",
        execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        endedReason: "subagent-killed",
        execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      });
      expect(
        vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
    } finally {
      writer.mockRestore();
    }
  });

  it("preserves stable operator cancellation when retiring expired tombstones", async () => {
    const mod = getRegistry();
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-operator-cancelled",
      childSessionKey: "agent:main:subagent:killed-operator-cancelled",
      childSessionIdentity: {
        sessionId: "session-killed-operator-cancelled",
        lifecycleRevision: "lifecycle-killed-operator-cancelled",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve operator cancellation",
      cleanup: "keep",
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

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps stable cancellation tombstones through the completion grace window", async () => {
    const mod = getRegistry();
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-grace",
      childSessionKey: "agent:main:subagent:killed-grace",
      childSessionIdentity: {
        sessionId: "session-killed-grace",
        lifecycleRevision: "lifecycle-killed-grace",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retain cancellation evidence",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      endedAt: now - 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
  });

  it("directly kills a replacement run through its durable task ID", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:replacement-direct-kill";
    await addCanonicalSubagentRunForTests({
      runId: "run-after-replacement-direct-kill",
      childSessionKey,
      childSessionIdentity: {
        sessionId: "session-replacement-direct-kill",
        lifecycleRevision: "lifecycle-replacement-direct-kill",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill replacement task",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 11 * 60_000,
    });

    expect(
      await mod.markSubagentRunTerminated({
        runId: "run-after-replacement-direct-kill",
        reason: "manual kill",
      }),
    ).toBe(1);
  });

  it("does not reconcile an older tombstone through a newer session task", async () => {
    const mod = getRegistry();
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-old-generation",
      childSessionKey: "agent:main:subagent:reused-session",
      childSessionIdentity: {
        sessionId: "session-reused-session",
        lifecycleRevision: "lifecycle-reused-session",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire old generation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: {
        killedAt: now - 5 * 60_000,
        supersededAt: now - 60_000,
      },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("retains newly rearmed requester custody while superseded cleanup is awaiting", async () => {
    const mod = getRegistry();
    vi.mocked(getAgentRunContext).mockReturnValue({} as never);
    const now = Date.now();
    const runId = "superseded-new-wake";
    const successorRunId = "superseded-new-wake-successor";
    const childSessionKey = "agent:main:subagent:superseded-new-wake";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey,
      childSessionIdentity: {
        sessionId: "session-superseded-new-wake",
        lifecycleRevision: "lifecycle-superseded-new-wake",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retain rearmed wake",
      cleanup: "keep",
      generation: 1,
      createdAt: now - 10 * 60_000,
      execution: {
        status: "terminal",
        endedAt: now - 5 * 60_000,
        outcome: { status: "error", error: "killed" },
        transcriptTarget: {
          agentId: "main",
          sessionId: "old-effects",
          sessionKey: "agent:main:internal-session-effects:old-wake",
          storePath: "/synthetic-old-effects",
        },
      },
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
    });
    await addCanonicalSubagentRunForTests({
      runId: successorRunId,
      childSessionKey,
      childSessionIdentity: {
        sessionId: "session-superseded-new-wake",
        lifecycleRevision: "lifecycle-superseded-new-wake",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "successor",
      cleanup: "keep",
      generation: 2,
      createdAt: now - 60_000,
    });
    const entered = createDeferred();
    const released = createDeferred();
    const cleanup = vi
      .spyOn(internalSessionEffects, "removeInternalSessionEffectsSession")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
      });
    const pending = mod.testing.sweepOnceForTests();
    try {
      await entered.promise;
      await mutateSubagentRuns([runId, successorRunId], (rows) => {
        const current = rows.get(runId)!;
        return {
          value: undefined,
          postimages: new Map<string, SubagentRunRecord | null>([
            [successorRunId, null],
            [
              runId,
              {
                ...current,
                requesterSettleWake: {
                  status: "pending",
                  attemptCount: 0,
                  rearmGeneration: 2,
                  batchRunIds: [runId],
                  requesterYieldBatch: true,
                },
              },
            ],
          ]),
        };
      });
    } finally {
      released.resolve();
      await pending;
      cleanup.mockRestore();
    }
    expect(subagentRuns.get(runId)?.requesterSettleWake?.rearmGeneration).toBe(2);
    expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterSettleWake?.rearmGeneration).toBe(
      2,
    );
    expect(subagentRuns.has(successorRunId)).toBe(false);
  });

  it("stabilizes killed tasks before their configured session archive deadline", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const archiveAtMs = now + 55 * 60_000;
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-retained-session",
      childSessionKey: "agent:main:subagent:killed-retained-session",
      childSessionIdentity: {
        sessionId: "session-killed-retained-session",
        lifecycleRevision: "lifecycle-killed-retained-session",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stabilize before archive",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs,
    });

    await mod.testing.sweepOnceForTests();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-killed-retained-session",
        archiveAtMs,
        suppressAnnounceReason: undefined,
      }),
    ]);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it("continues killed cleanup when ended hook loading fails", async () => {
    const mod = getRegistry();
    const now = Date.now();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockImplementation(() => {
      throw new Error("plugin load failed");
    });
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-hook-load-failure",
      childSessionKey: "agent:main:subagent:killed-hook-load-failure",
      childSessionIdentity: {
        sessionId: "session-killed-hook-load-failure",
        lifecycleRevision: "lifecycle-killed-hook-load-failure",
      },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cleanup despite hook failure",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await expect(mod.testing.sweepOnceForTests()).resolves.toBeUndefined();
    await vi.dynamicImportSettled();

    await waitForNoRequesterRuns();
  });
}
