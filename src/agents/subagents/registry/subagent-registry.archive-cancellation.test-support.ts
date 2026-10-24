import { expect, it, vi } from "vitest";
import { callGateway } from "../../../gateway/call.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import * as internalSessionEffects from "../../internal-session-effects.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ArchiveRunInput = Parameters<SubagentRegistryHarness["addSubagentRunForTests"]>[0];

function createKilledArchiveRun(
  id: string,
  now: number,
  overrides: Pick<ArchiveRunInput, "task"> & Partial<ArchiveRunInput>,
): ArchiveRunInput {
  return {
    runId: `run-${id}`,
    childSessionKey: `agent:main:subagent:${id}`,
    childSessionIdentity: {
      sessionId: `session-${id}`,
      lifecycleRevision: `lifecycle-${id}`,
    },
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    cleanup: "keep",
    createdAt: now - 10 * 60_000,
    endedAt: now - 5 * 60_000,
    endedReason: "subagent-killed",
    outcome: { status: "error", error: "manual kill" },
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: now - 5 * 60_000 },
    cleanupHandled: true,
    cleanupCompletedAt: now - 5 * 60_000,
    ...overrides,
  };
}

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
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-tombstone-expired", now, {
        task: "expire killed tombstone",
        cleanup: "delete",
        startedAt: now - 10 * 60_000,
        killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
        archiveAtMs: now,
      }),
    );

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    expect(
      vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
  });

  it("retains cancellation evidence when the retirement write is rejected", async () => {
    const now = Date.now();
    const runId = "run-killed-tombstone-retry";
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-tombstone-retry", now, {
        runId,
        task: "retry killed tombstone",
        cleanup: "delete",
        // The requester already knows; exercise direct archive retirement.
        killReconciliation: {
          killedAt: now - 5 * 60_000,
          taskCancellationAccepted: true,
          suppressTaskDelivery: true,
        },
        archiveAtMs: now,
      }),
    );
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
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-operator-cancelled", now, {
        task: "preserve operator cancellation",
        killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
        archiveAtMs: now,
      }),
    );

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps stable cancellation tombstones through the completion grace window", async () => {
    const mod = getRegistry();
    const now = Date.now();
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-grace", now, {
        task: "retain cancellation evidence",
        createdAt: now - 2 * 60_000,
        endedAt: now - 60_000,
        killReconciliation: { killedAt: now - 60_000, taskCancellationAccepted: true },
        cleanupCompletedAt: now - 60_000,
        archiveAtMs: now,
      }),
    );

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
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("reused-session", now, {
        runId: "run-old-generation",
        task: "expire old generation",
        sessionStartedAt: now - 10 * 60_000,
        killReconciliation: {
          killedAt: now - 5 * 60_000,
          supersededAt: now - 60_000,
        },
      }),
    );

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
    const cleanupGate = createEnteredGate();
    const cleanup = vi
      .spyOn(internalSessionEffects, "removeInternalSessionEffectsSession")
      .mockImplementationOnce(cleanupGate.wait);
    const pending = mod.testing.sweepOnceForTests();
    try {
      await cleanupGate.entered;
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
      cleanupGate.release();
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
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-retained-session", now, {
        task: "stabilize before archive",
        cleanup: "delete",
        archiveAtMs,
      }),
    );

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
    await addCanonicalSubagentRunForTests(
      createKilledArchiveRun("killed-hook-load-failure", now, {
        task: "cleanup despite hook failure",
      }),
    );

    await expect(mod.testing.sweepOnceForTests()).resolves.toBeUndefined();
    await vi.dynamicImportSettled();

    await waitForNoRequesterRuns();
  });
}
