// Subagent registry persistence tests cover SQLite registry restore, child
// session timing writes, and restart cleanup behavior.
import { describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { announceSpy, createSubagentPersistenceRuntime, useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { callGateway } from "../../../gateway/call.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.types.js";
import { sessionSharingTestContext } from "../../../gateway/server-methods/sessions-sharing.test-support.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import * as stateContext from "../../../state/openclaw-state-worker-context.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import * as announceCleanup from "./subagent-registry-lifecycle-announce-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
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
  const readPersistedRegistry = () => ({
    runs: Object.fromEntries(loadSubagentRegistryFromSqlite()),
  });

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
    await resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    const recoveryRuntime = createSubagentPersistenceRuntime(callGateway);
    const gateway = {
      recoveryRuntime,
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      resolveGatewayContext: () => gateway as never,
    };
    await activateSubagentRegistry(() => gateway as never);
  };

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
      await restoreSubagentRunsFromDisk({ runs: new Map() });
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
    expect(await getSubagentRunByChildSessionKey("agent:main:subagent:live-child")).toMatchObject({
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

    await closeOpenClawStateDatabaseAsync();
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
        (await getSubagentRunByChildSessionKey(childSessionKey))?.cleanupHandled,
        "acknowledged runtime lock remains held; decoded durable row is restart-ready",
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

  it.each(["restart", "suspension"] as const)(
    "retains an admitted resume read across a %s fence",
    async (fence) => {
      await fixture.allocateStateDir();
      const runId = "admitted-resume-read";
      const now = Date.now();
      const entry = makeRun(runId, {
        createdAt: now,
        expectsCompletionMessage: false,
        execution: { status: "running", startedAt: now },
      });
      await addSubagentRunForTests(entry);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const parent = tryBeginGatewayRootWorkAdmission("test:resume-parent");
      if (!parent) {
        throw new Error("Expected an admitted resume parent");
      }
      const entered = createDeferred();
      const releaseRead = createDeferred();
      const read = sessionReads.readSessionEntryReadOnlyInWorker;
      const reader = vi
        .spyOn(sessionReads, "readSessionEntryReadOnlyInWorker")
        .mockImplementation(async (input, assertCurrent) => {
          if (input.sessionKey === entry.childSessionKey) {
            entered.resolve();
            await releaseRead.promise;
          }
          return read(input, assertCurrent);
        });
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
      const reopen = () => {
        suspension?.release();
        resetGatewayWorkAdmission();
      };
      let retainedRoots: number | undefined;
      try {
        await parent.run(async () => {
          if (fence === "restart") {
            markGatewayRestartDraining();
          } else {
            suspension = tryBeginGatewaySuspendAdmission(() => {});
            expect(suspension?.drain()).toBe(true);
          }
          resumeSubagentRun(runId);
          parent.release();
          retainedRoots = getActiveGatewayRootWorkCount();
        });
        expect(
          retainedRoots,
          "the resume read retains root custody after its admitted parent releases",
        ).toBe(1);
        await entered.promise;
        expect(readPersistedRun(runId)?.execution.status).toBe("running");
        releaseRead.resolve();
        await fixture.settle();
        expect(readPersistedRun(runId)).toMatchObject({
          execution: {
            status: "terminal",
            outcome: { status: "error", error: "subagent run orphaned: missing-session-entry" },
          },
          cleanupCompletedAt: expect.any(Number),
        });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        const newRoot = tryBeginGatewayRootWorkAdmission();
        try {
          expect(newRoot).toBeNull();
        } finally {
          newRoot?.release();
        }
      } finally {
        releaseRead.resolve();
        parent.release();
        if (getActiveGatewayRootWorkCount() === 0) {
          reopen();
        }
        try {
          await fixture.settle();
        } finally {
          reopen();
          reader.mockRestore();
        }
      }
    },
  );

  it.each([
    "completed owner",
    "terminal capture refusal",
    "admitted drain capture refusal",
    "session publication",
    "worker read failure",
    "run replacement",
    "lifecycle retirement",
    "state retirement",
    "Gateway replacement",
    "run Gateway replacement",
  ] as const)("revalidates one admitted resume read after %s", async (change) => {
    const admittedDrain = change === "admitted drain capture refusal";
    await fixture.allocateStateDir();
    let gateway = sessionSharingTestContext(vi.fn());
    const resolveGatewayContext = () => gateway;
    gateway.resolveGatewayContext = resolveGatewayContext;
    if (change === "Gateway replacement") {
      await activateSubagentRegistry(resolveGatewayContext);
    }
    const runId = "held-resume-read";
    const now = Date.now();
    const entry = makeRun(runId, {
      createdAt: now,
      startedAt: now,
      expectsCompletionMessage: false,
      execution: { status: "running", startedAt: now },
    });
    await addSubagentRunForTests(entry);
    if (change === "worker read failure") {
      await writeChildSessionEntry({
        sessionKey: entry.childSessionKey,
        sessionId: "read-error-session",
        updatedAt: now,
      });
    }
    if (change === "run Gateway replacement") {
      bindGatewayContextResolver(subagentRuns.get(runId)!, resolveGatewayContext);
    }
    const entered = createDeferred();
    const release = createDeferred();
    let settling: Promise<void> | undefined;
    let restoreLifecycle: (() => void) | undefined;
    let restoreCleanup: (() => void) | undefined;
    const read = sessionReads.readSessionEntryReadOnlyInWorker;
    let reads = 0;
    let readFailures = 0;
    const reader = vi
      .spyOn(sessionReads, "readSessionEntryReadOnlyInWorker")
      .mockImplementation(async (input, assertCurrent) => {
        const selected = input.sessionKey === entry.childSessionKey;
        if (selected) {
          expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        }
        const result = await read(input, assertCurrent);
        if (selected && ++reads === 1) {
          if (change === "worker read failure") {
            expect(result).toMatchObject({ sessionId: "read-error-session" });
          } else {
            expect(result).toBeUndefined();
          }
          entered.resolve();
          await release.promise;
          if (change === "worker read failure") {
            readFailures += 1;
            throw new Error("Synthetic resume session read failure");
          }
        }
        return result;
      });
    try {
      resumeSubagentRun(runId);
      settling = fixture.settle();
      await awaitGateBeforeSettlement(
        entered.promise,
        settling,
        "Resume did not reach its admitted worker session read",
      );
      resumeSubagentRun(runId);
      expect(reads).toBe(1);
      if (
        change === "completed owner" ||
        change === "terminal capture refusal" ||
        admittedDrain ||
        change === "run replacement"
      ) {
        await mutateSubagentRuns([runId], (rows) => {
          const current = rows.get(runId)!;
          const next: SubagentRunRecord =
            change !== "run replacement"
              ? {
                  ...current,
                  execution: {
                    ...current.execution,
                    status: "terminal",
                    endedAt: now + 1,
                    outcome: { status: "ok", endedAt: now + 1 },
                  },
                  cleanupHandled: change === "completed owner",
                  cleanupCompletedAt: change === "completed owner" ? now + 1 : undefined,
                  ...(change === "terminal capture refusal" || admittedDrain
                    ? { suppressCompletionDelivery: true }
                    : {}),
                }
              : { ...current, generation: (current.generation ?? 0) + 1 };
          return { value: undefined, postimages: new Map([[runId, next]]) };
        });
      } else if (change === "session publication") {
        await writeChildSessionEntry({
          sessionKey: entry.childSessionKey,
          sessionId: "published-resume-session",
          updatedAt: now,
        });
        await mutateSubagentRuns([runId], (rows) => ({
          value: undefined,
          postimages: new Map([[runId, { ...rows.get(runId)!, label: "published session" }]]),
        }));
      } else if (change === "lifecycle retirement") {
        const lifecycle = vi
          .spyOn(agentEvents, "isAgentEventLifecycleGenerationCurrent")
          .mockReturnValue(false);
        restoreLifecycle = () => lifecycle.mockRestore();
      } else if (change === "state retirement") {
        await closeOpenClawStateDatabaseAsync();
      } else if (change === "Gateway replacement" || change === "run Gateway replacement") {
        gateway = sessionSharingTestContext(vi.fn());
        gateway.resolveGatewayContext = resolveGatewayContext;
      }
      const expected = readPersistedRun(runId);
      if (change === "terminal capture refusal") {
        const failure = new Error("Synthetic cleanup capture refusal");
        const capture = vi
          .spyOn(stateContext, "captureOpenClawStateWorkerContext")
          .mockImplementationOnce(() => {
            throw failure;
          });
        try {
          expect(() => resumeSubagentRun(runId)).toThrow(failure);
        } finally {
          capture.mockRestore();
        }
      }
      if (admittedDrain) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const startCleanup = announceCleanup.startSubagentAnnounceCleanupFlow;
        const cleanup = vi
          .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
          .mockImplementationOnce((...args) => {
            const capture = vi
              .spyOn(stateContext, "captureOpenClawStateWorkerContext")
              .mockImplementationOnce(() => {
                throw new Error("Synthetic admitted cleanup capture refusal");
              });
            try {
              return startCleanup(...args);
            } finally {
              capture.mockRestore();
            }
          });
        restoreCleanup = () => cleanup.mockRestore();
        markGatewayRestartDraining();
      }
      release.resolve();
      if (admittedDrain) {
        await expect(settling).rejects.toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "Synthetic admitted cleanup capture refusal" }),
          ]),
        });
        settling = undefined;
      } else {
        await settling;
      }
      restoreLifecycle?.();
      await fixture.settle();
      if (change === "session publication") {
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(readPersistedRun(runId)?.execution.outcome).toMatchObject({ status: "ok" });
      } else if (change === "worker read failure") {
        expect(readFailures).toBe(1);
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "agent.wait",
            params: expect.objectContaining({ runId }),
          }),
        );
        expect(readPersistedRun(runId)?.execution.outcome).toMatchObject({ status: "ok" });
      } else {
        expect(readPersistedRun(runId)).toEqual(expected);
        expect(callGateway).not.toHaveBeenCalled();
        expect(reads).toBe(1);
      }
      expect(subagentRuns.has(runId)).toBe(true);
      if (change === "terminal capture refusal" || admittedDrain) {
        if (admittedDrain) {
          resetGatewayWorkAdmission();
          await vi.advanceTimersByTimeAsync(1_000);
        } else {
          resumeSubagentRun(runId);
        }
        await fixture.settle();
        expect(readPersistedRun(runId)?.cleanupCompletedAt).toBeTypeOf("number");
      }
    } finally {
      release.resolve();
      try {
        await settling;
      } finally {
        restoreLifecycle?.();
        restoreCleanup?.();
        if (admittedDrain) {
          resetGatewayWorkAdmission();
          vi.useRealTimers();
        }
        try {
          await fixture.settle();
        } finally {
          reader.mockRestore();
        }
      }
    }
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
    announceSpy,
    flushQueuedRegistryWork,
    readPersistedRegistry,
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
    expect(
      (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.outcome,
    ).toMatchObject({
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
    await addSubagentRunForTests({
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
