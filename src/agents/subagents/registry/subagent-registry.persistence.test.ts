// Subagent registry persistence tests cover SQLite registry restore, child
// session timing writes, and restart cleanup behavior.
import { describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { announceSpy, createSubagentPersistenceRuntime, useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { callGateway } from "../../../gateway/call.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import { registerSubagentOrphanTaskCases } from "./subagent-registry.persistence.orphan.test-support.js";
import type { SubagentRunFixture } from "./subagent-registry.persistence.test-support.js";
import {
  canonicalSubagentRunFixtures,
  createCanonicalSubagentRunFixture,
  expectDeferredSubagentAnnouncement,
  gateSubagentRequesterSettlement,
  readSubagentSessionStore,
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  resumeSubagentRun,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("./subagent-registry-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-state.js")>();
  const { saveSubagentRegistryToSqlite: saveRegistryToSqlite } =
    await import("./subagent-registry.store.sqlite.js");
  return { ...actual, persistSubagentRunsToDisk: saveRegistryToSqlite };
});

function makeRun(runId: string, overrides: Partial<SubagentRunFixture> = {}): SubagentRunRecord {
  return createCanonicalSubagentRunFixture({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  });
}

describe("subagent registry persistence", () => {
  const fixture = useSubagentPersistenceFixture();

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    return await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      abortedLastRun: params.abortedLastRun,
      defaultSessionId: `sess-${agentId}-${Date.now()}`,
    });
  };

  const removeChildSessionEntry = async (sessionKey: string) => {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    return await removeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      sessionKey,
    });
  };

  const persistRuns = async (runs: SubagentRunRecord[], seedChildSessions = true) => {
    await fixture.allocateStateDir();
    saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
    if (seedChildSessions) {
      for (const run of runs) {
        await writeChildSessionEntry({
          sessionKey: run.childSessionKey,
          sessionId: `sess-${run.runId}`,
        });
      }
    }
  };
  const writePersistedRegistry = (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) =>
    persistRuns(
      [
        ...canonicalSubagentRunFixtures(
          new Map(Object.entries((persisted.runs ?? {}) as Record<string, SubagentRunFixture>)),
        ).values(),
      ],
      opts?.seedChildSessions !== false,
    );
  const endedRun = (runId: string, overrides: Partial<SubagentRunFixture> = {}) => {
    const now = Date.now();
    return makeRun(runId, { createdAt: now - 2, startedAt: now - 1, endedAt: now, ...overrides });
  };
  const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForRegistryWork = async (predicate: () => boolean | Promise<boolean>) => {
    await vi.waitFor(async () => expect(await predicate()).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  };

  const restartRegistry = async () => {
    resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    const recoveryRuntime = createSubagentPersistenceRuntime(callGateway);
    const gateway = { recoveryRuntime, resolveGatewayContext: () => gateway as never };
    await activateSubagentRegistry(() => gateway as never);
  };

  it("persists completed subagent timing into the child session entry", async () => {
    await fixture.allocateStateDir();

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;

    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    await patchSessionEntryCore({ storePath, sessionKey: "agent:main:subagent:timing" }, () => ({
      lastRunError: "Previous setup failed",
    }));
    await persistSubagentSessionTiming(
      makeRun("run-session-timing", {
        childSessionKey: "agent:main:subagent:timing",
        createdAt: startedAt,
        sessionStartedAt: startedAt,
        accumulatedRuntimeMs: 0,
        execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
      }),
    );

    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.lastRunError).toBeUndefined();
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it.each([false, true])(
    "preserves session state when timing commit is denied (current=%s)",
    async (isCurrent) => {
      await fixture.allocateStateDir();

      const startedAt = Date.now();
      const storePath = await writeChildSessionEntry({
        sessionKey: "agent:main:subagent:stale-timing",
        sessionId: "sess-stale-timing",
        updatedAt: startedAt - 1,
      });
      const write = persistSubagentSessionTiming(
        makeRun("run-stale-timing", {
          childSessionKey: "agent:main:subagent:stale-timing",
          createdAt: startedAt,
          execution: {
            status: "terminal",
            startedAt,
            endedAt: startedAt + 500,
            outcome: { status: "ok" },
          },
        }),
        {
          isCurrentGeneration: () => isCurrent,
          assertCommitAllowed: () => {
            throw new Error("timing commit denied");
          },
        },
      );
      if (isCurrent) {
        await expect(write).rejects.toThrow("timing commit denied");
      } else {
        await expect(write).resolves.toBeUndefined();
      }

      const persisted = (await readSubagentSessionStore(storePath))[
        "agent:main:subagent:stale-timing"
      ];
      expect(persisted).toMatchObject({
        sessionId: "sess-stale-timing",
        updatedAt: startedAt - 1,
      });
      expect(persisted?.startedAt).toBeUndefined();
      expect(persisted?.endedAt).toBeUndefined();
      expect(persisted?.status).toBeUndefined();
    },
  );

  it("does not overwrite durable completion with a provisional killed status", async () => {
    await fixture.allocateStateDir();

    const startedAt = Date.now();
    const completedAt = startedAt + 500;
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:kill-race",
      sessionId: "sess-kill-race",
      updatedAt: completedAt,
    });
    const store = await readSubagentSessionStore(storePath);
    await replaceSessionEntry({ storePath, sessionKey: "agent:main:subagent:kill-race" }, {
      ...store["agent:main:subagent:kill-race"],
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
      abortedLastRun: true,
    } as SessionEntry);

    await persistSubagentSessionTiming(
      makeRun("run-kill-race", {
        childSessionKey: "agent:main:subagent:kill-race",
        createdAt: startedAt,
        endedReason: "subagent-killed",
        execution: {
          status: "terminal",
          startedAt,
          endedAt: completedAt + 1,
          outcome: { status: "error", error: "manual kill" },
        },
      }),
    );

    const persisted = (await readSubagentSessionStore(storePath))["agent:main:subagent:kill-race"];
    expect(persisted).toMatchObject({
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
    });
    expect(persisted?.abortedLastRun).toBeUndefined();
  });

  it("reuses the persisted registry cache on hot internal read snapshots", async () => {
    await persistRuns([makeRun("run-cached-read", { startedAt: 1 })], false);
    const previousFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    let cloneSpy: { mockRestore(): void } | undefined;
    try {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
      getSubagentRunsSnapshotForRead(new Map());
      cloneSpy = vi.spyOn(globalThis, "structuredClone");
      const snapshot = getSubagentRunsSnapshotForRead(new Map());

      expect(snapshot.has("run-cached-read")).toBe(true);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy?.mockRestore();
      if (previousFlag === undefined) {
        delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
      } else {
        process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previousFlag;
      }
    }
  });

  it("normalizes newly registered session keys to canonical trimmed values", async () => {
    await fixture.allocateStateDir();

    vi.mocked(callGateway).mockResolvedValueOnce({
      status: "pending",
    });

    await registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      controllerSessionKey: " agent:main:subagent:live-controller ",
      requesterSessionKey: " agent:main:main ",
      requesterDisplayKey: "main",
      task: "live spaced keys",
      cleanup: "keep",
    });

    const liveRuns = listSubagentRunsForRequester("agent:main:main");
    expect(liveRuns).toHaveLength(1);
    expect(liveRuns[0]).toMatchObject({
      runId: "run-live",
      childSessionKey: "agent:main:subagent:live-child",
      controllerSessionKey: "agent:main:subagent:live-controller",
      requesterSessionKey: "agent:main:main",
    });
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:live-child")).toMatchObject({
      runId: "run-live",
    });
  });

  it("reloads waitable swarm collector completions after a gateway restart", async () => {
    await fixture.allocateStateDir();
    const run = makeRun("run-swarm-restart", {
      childSessionKey: "agent:worker:subagent:swarm-restart",
      execution: { status: "terminal", endedAt: 2 },
      collect: true,
      swarmRequesterSessionKey: "agent:worker:subagent:owner",
      swarmWaitOwnerSessionKeys: ["agent:worker:subagent:owner", "agent:main:main"],
      groupId: "swarm:agent:main:main:parent-run",
      outputSchema: { type: "object", required: ["answer"] },
      completion: { required: false, resultText: "raw answer", capturedAt: 2 },
      collectorCompletion: {
        status: "done",
        structured: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    await writeChildSessionEntry({
      sessionKey: run.childSessionKey,
      sessionId: "session-swarm-restart",
      updatedAt: run.execution.endedAt,
    });

    closeOpenClawStateDatabaseForTest();
    const restored = loadSubagentRegistryFromSqlite().get(run.runId);

    expect(restored).toMatchObject({
      runId: run.runId,
      collect: true,
      swarmRequesterSessionKey: run.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys: run.swarmWaitOwnerSessionKeys,
      groupId: run.groupId,
      outputSchema: run.outputSchema,
      completion: { resultText: "raw answer" },
      collectorCompletion: {
        status: "done",
        structured: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });

    await restartRegistry();
    const wait = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    const waited = await wait.execute("wait-after-restart", {
      ids: [run.runId],
      timeoutSeconds: 0,
    });
    expect(waited.details).toMatchObject({
      completed: [
        {
          runId: run.runId,
          status: "done",
          result: "raw answer",
          structured: { answer: 42 },
        },
      ],
      pending: [],
    });
  });

  it.each([
    {
      name: "retries cleanup announce after announce flow rejects",
      runId: "run-reject",
      cleanup: "keep",
      reject: true,
    },
    {
      name: "keeps delete-mode runs retryable when announce is deferred",
      runId: "run-4",
      cleanup: "delete",
      reject: false,
    },
  ] as const)("$name", async ({ runId, cleanup, reject }) => {
    const childSessionKey = `agent:main:subagent:${runId}`;
    await persistRuns([endedRun(runId, { childSessionKey, cleanup })]);
    const announcement = createDeferred<"retryable">();
    const releaseAnnouncement = () =>
      reject ? announcement.reject(new Error("announce boom")) : announcement.resolve("retryable");
    const requesterSettle = await import("../announce/subagent-announce.requester-settle-wake.js");
    const settlement = gateSubagentRequesterSettlement(
      requesterSettle.maybeWakeRequesterAfterAllChildrenSettled,
    );
    vi.spyOn(requesterSettle, "maybeWakeRequesterAfterAllChildrenSettled").mockImplementation(
      settlement.run,
    );
    announceSpy.mockImplementationOnce(() => announcement.promise);
    let retryReady = false;
    let readiness: Promise<void> | undefined;
    try {
      await restartRegistry();
      await vi.waitFor(
        () => expect(announceSpy, "first announcement admitted").toHaveBeenCalledOnce(),
        {
          timeout: 5_000,
          interval: 1,
        },
      );
      readiness = vi
        .waitFor(
          () => {
            expectDeferredSubagentAnnouncement(loadSubagentRegistryFromSqlite().get(runId), runId);
          },
          { timeout: 5_000, interval: 1 },
        )
        .then(() => {
          retryReady = true;
        });
      await vi.dynamicImportSettled();
      const held = loadSubagentRegistryFromSqlite().get(runId);
      expect(held?.cleanupHandled, "serialized lock is not retry readiness").toBe(false);
      expect(
        getSubagentRunByChildSessionKey(childSessionKey)?.cleanupHandled,
        "announcement still owns cleanup",
      ).toBe(true);
      expect(
        held?.delivery?.attemptCount,
        "no deferral before announcement settles",
      ).toBeUndefined();
      expect(held?.delivery?.payload).toBeUndefined();
      expect(held?.delivery?.nextAttemptAt).toBeUndefined();
      expect(retryReady, "retry readiness must remain pending while announcement is held").toBe(
        false,
      );
      releaseAnnouncement();
      await readiness;
      expect(announceSpy, "first attempt deferred").toHaveBeenCalledOnce();
      await fixture.settle();

      announceSpy.mockResolvedValueOnce("delivered");
      const beforeRetry = Date.now();
      await restartRegistry();
      await vi.waitFor(
        () => expect(settlement.run, "retry reached requester settlement").toHaveBeenCalledOnce(),
        {
          timeout: 5_000,
          interval: 1,
        },
      );
      expect(announceSpy, "explicit retry delivered").toHaveBeenCalledTimes(2);
      const delivered = loadSubagentRegistryFromSqlite().get(runId);
      expect(delivered, "delivery precedes requester settlement").toMatchObject({
        delivery: { status: "delivered" },
      });
      expect(delivered?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
      expect(
        getActiveGatewayRootWorkCount(),
        "held settlement still owns root work",
      ).toBeGreaterThan(0);
      if (cleanup === "delete") {
        expect(
          delivered?.requesterSettleWake?.retireAfterSettle,
          "delete waits for real settlement",
        ).toBe(true);
      }
      await settlement.release();
      expect(settlement.run).toHaveBeenCalledOnce();
      const afterSecond = readPersistedRun(runId);
      if (cleanup === "delete") {
        expect(afterSecond, "settled delete retires its durable row").toBeUndefined();
      } else {
        expect(afterSecond?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
      }
    } finally {
      releaseAnnouncement();
      await Promise.all([announcement.promise.catch(() => {}), readiness, settlement.release()]);
    }
  });

  it("settles orphaned restored runs through canonical completion", async () => {
    const runId = "run-orphan-restore";
    await persistRuns([endedRun(runId)], false);
    await restartRegistry();
    await waitForRegistryWork(() => readPersistedRun(runId)?.cleanupCompletedAt !== undefined);
    expect(readPersistedRun(runId)?.execution).toMatchObject({
      status: "terminal",
      outcome: { status: "error", error: "subagent run orphaned: missing-session-entry" },
    });
  });

  it("preserves restored killed tombstones until bounded reconciliation", async () => {
    const now = Date.now();
    const runId = "run-killed-restore-tombstone";
    await persistRuns(
      [
        endedRun(runId, {
          createdAt: now - 100,
          startedAt: now - 50,
          endedAt: now,
          endedReason: "subagent-killed",
          outcome: { status: "error", error: "manual kill" },
          suppressAnnounceReason: "killed",
          killReconciliation: { killedAt: now },
          cleanupHandled: true,
          cleanupCompletedAt: now,
        }),
      ],
      false,
    );

    await restartRegistry();
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId,
        endedReason: "subagent-killed",
        suppressAnnounceReason: "killed",
      }),
    ]);
  });

  it("preserves restored interrupted-recovery owners for orphan replay", async () => {
    const now = Date.now();
    const runId = "run-interrupted-recovery-restore";
    await persistRuns(
      [
        endedRun(runId, {
          createdAt: now - 100,
          startedAt: now - 50,
          endedAt: now,
          endedReason: "subagent-error",
          outcome: { status: "error", error: "restart interrupted run" },
          terminalOwner: "interrupted-recovery",
          completion: { required: false, resultText: null, capturedAt: now },
        }),
      ],
      false,
    );

    await restartRegistry();
    await flushQueuedRegistryWork();

    expect(callGateway).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId, terminalOwner: "interrupted-recovery" }),
    ]);
    await testing.sweepOnceForTests();
  });

  registerSubagentOrphanTaskCases({
    writePersistedRegistry,
    restartRegistry,
    waitForRegistryWork,
  });

  it("finalizes restored interrupted runs without replay", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({ status: "pending" });
    const now = Date.now();
    const runId = "run-stale-aborted-restore";
    const childSessionKey = "agent:main:subagent:stale-aborted-restore";
    await persistRuns(
      [
        makeRun(runId, {
          childSessionKey,
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        }),
      ],
      false,
    );
    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted-restore",
      // A retained interruption is reconciled even when its last activity is old.
      updatedAt: now - 3 * 60 * 60 * 1_000,
      abortedLastRun: true,
    });

    await restartRegistry();
    await flushQueuedRegistryWork();
    await testing.sweepOnceForTests();

    // The dead pre-restart run is terminalized without querying its stale run id.
    expect(callGateway).not.toHaveBeenCalled();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("Gateway restart"),
    });
  });

  it("resume preserves steer-restart ownership when the child session is missing", async () => {
    await fixture.allocateStateDir();
    const runId = "run-orphan-resume-guard";
    const childSessionKey = "agent:main:subagent:ghost-resume";
    const now = Date.now();

    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume orphan guard",
      cleanup: "keep",
      createdAt: now - 50,
      startedAt: now - 25,
      endedAt: now,
      execution: { status: "terminal", startedAt: now - 25, endedAt: now },
      completion: { required: false },
      delivery: { status: "pending" },
      suppressAnnounceReason: "steer-restart",
      cleanupHandled: false,
    });
    await removeChildSessionEntry(childSessionKey);

    resumeSubagentRun(runId);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId, suppressAnnounceReason: "steer-restart" }),
    ]);
  });
});
