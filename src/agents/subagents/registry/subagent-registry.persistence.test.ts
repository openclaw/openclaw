import { beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { activateSubagentPersistenceRegistry, announceSpy, createSubagentPersistenceRuntime, useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../../config/sessions/session-entry-current-check.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { callGateway } from "../../../gateway/call.js";
import { sessionSharingTestContext } from "../../../gateway/server-methods/sessions-sharing.test-support.js";
import * as agentEvents from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { runSessionMutation } from "../../../sessions/session-controller.lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import * as stateContext from "../../../state/openclaw-state-worker-context.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import * as announceCleanup from "./subagent-registry-lifecycle-announce-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentOrphanTaskCases } from "./subagent-registry.persistence.orphan.test-support.js";
import type { SubagentRunFixture } from "./subagent-registry.persistence.test-support.js";
import {
  createCanonicalSubagentRunFixture,
  expectDeferredSubagentAnnouncement,
  gateSubagentRequesterSettlement,
  prepareSubagentRecoveryFixture,
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
  beforeEach(() => fixture.allocateStateDir());

  const agentIdFor = (key: string) =>
    (key.match(/^agent:([^:]+):/i)?.[1] ?? "main").trim().toLowerCase() || "main";
  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    const agentId = agentIdFor(params.sessionKey);
    return writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      ...params,
      defaultSessionId: `sess-${agentId}-${Date.now()}`,
    });
  };

  const removeChildSessionEntry = (sessionKey: string) =>
    removeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: agentIdFor(sessionKey),
      sessionKey,
    });

  const writePersistedRegistry = async (persisted: Record<string, unknown>) => {
    const runs = Object.values((persisted.runs ?? {}) as Record<string, SubagentRunFixture>).map(
      createCanonicalSubagentRunFixture,
    );
    saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
    for (const run of runs) {
      await writeChildSessionEntry({
        sessionKey: run.childSessionKey,
        sessionId: `sess-${run.runId}`,
      });
    }
  };
  const endedRun = (runId: string, overrides: Partial<SubagentRunFixture> = {}) => {
    const now = Date.now();
    return makeRun(runId, { createdAt: now - 2, startedAt: now - 1, endedAt: now, ...overrides });
  };
  const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForRegistry = (assertion: () => void | Promise<void>) =>
    vi.waitFor(assertion, { interval: 1, timeout: 5_000 });
  const waitForRegistryWork = (predicate: () => boolean | Promise<boolean>) =>
    waitForRegistry(async () => expect(await predicate()).toBe(true));

  const restartRegistry = async () => {
    await resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    await activateSubagentPersistenceRegistry({ activateSubagentRegistry }, callGateway);
  };
  const timingFixture = async (
    name: string,
    updatedAt: number,
    overrides: Partial<SubagentRunFixture>,
  ) => {
    const childSessionKey = `agent:main:subagent:${name}`;
    const session = { sessionId: `sess-${name}`, updatedAt };
    const storePath = await writeChildSessionEntry({ sessionKey: childSessionKey, ...session });
    return {
      key: childSessionKey,
      session,
      storePath,
      run: makeRun(`run-${name}`, { childSessionKey, ...overrides }),
    };
  };
  const runningRun = (runId: string) => {
    const now = Date.now();
    return makeRun(runId, {
      createdAt: now,
      childSessionIdentity: { sessionId: `sess-${runId}` },
      expectsCompletionMessage: false,
      execution: { status: "running", startedAt: now },
    });
  };
  const writeRunSession = (entry: SubagentRunRecord) =>
    writeChildSessionEntry({
      sessionKey: entry.childSessionKey,
      sessionId: entry.childSessionIdentity?.sessionId,
      updatedAt: entry.createdAt,
    });
  const holdSessionRead = (entry: SubagentRunRecord, beforeRead = false, fail = false) => {
    const entered = createDeferred();
    const release = createDeferred();
    const read = sessionReads.readSessionEntryReadOnlyInWorker;
    let reads = 0;
    const spy = vi
      .spyOn(sessionReads, "readSessionEntryReadOnlyInWorker")
      .mockImplementation(async (input, assertCurrent) => {
        const result = beforeRead ? undefined : await read(input, assertCurrent);
        if (input.sessionKey === entry.childSessionKey && ++reads === 1) {
          entered.resolve();
          await release.promise;
          if (fail) {
            throw new Error("Synthetic resume session read failure");
          }
        }
        return beforeRead ? read(input, assertCurrent) : result;
      });
    return { entered: entered.promise, release: () => release.resolve(), spy, reads: () => reads };
  };

  it.each([false, true])(
    "preserves session state when timing commit is denied (current=%s)",
    async (isCurrent) => {
      const startedAt = Date.now();
      const { run, storePath, key } = await timingFixture("stale-timing", startedAt - 1, {
        createdAt: startedAt,
        startedAt,
        endedAt: startedAt + 500,
        outcome: { status: "ok" },
      });
      const write = persistSubagentSessionTiming(run, {
        isCurrentGeneration: () => isCurrent,
        assertCommitAllowed: () => {
          throw new Error("timing commit denied");
        },
      });
      if (isCurrent) {
        await expect(write).rejects.toThrow("timing commit denied");
      } else {
        await expect(write).resolves.toBeUndefined();
      }

      const persisted = (await readSubagentSessionStore(storePath))[key];
      expect(persisted).toMatchObject({
        sessionId: "sess-stale-timing",
        updatedAt: startedAt - 1,
      });
      expect(persisted?.startedAt).toBeUndefined();
      expect(persisted?.endedAt).toBeUndefined();
      expect(persisted?.status).toBeUndefined();
    },
  );

  it.each(["reset", "delete"] as const)(
    "preserves the retained session row when late timing settles during %s",
    async (kind) => {
      const { key, session, storePath, run } = await timingFixture("mutation-timing", 999, {
        startedAt: 1_000,
        endedAt: 1_500,
        outcome: { status: "ok" },
      });
      const retained = (await readSubagentSessionStore(storePath))[key];
      const current = await captureSessionEntryCurrentCheckAsyncInternal({
        agentId: "main",
        storePath,
        sessionKey: key,
      });
      if (!current.entryCurrent || current.entryCurrent.source.path === storePath) {
        current.release();
        throw new Error("Expected native currency distinct from the logical controller scope");
      }
      const entered = createDeferred();
      const released = createDeferred();
      const blocker = patchSessionEntryCore(
        { storePath, sessionKey: key },
        async () => {
          entered.resolve();
          await released.promise;
          return null;
        },
        { skipMaintenance: true },
      );
      let timing: Promise<void> | undefined;
      try {
        await entered.promise;
        // Start the real timing writer before destructive ownership is acquired.
        timing = persistSubagentSessionTiming(run, { sessionEntryCurrent: current.entryCurrent });
        await runSessionMutation({
          scope: storePath,
          identities: [key, session.sessionId],
          kind,
          run: async () => {
            released.resolve();
            await blocker;
            await timing;
            expect((await readSubagentSessionStore(storePath))[key]).toEqual(retained);
          },
        });
      } finally {
        released.resolve();
        try {
          await blocker;
          await timing;
        } finally {
          current.release();
        }
      }
    },
  );

  it.each([false, true])(
    "persists terminal timing inside ordinary kill ownership (queued=%s)",
    async (queued) => {
      const { key, session, storePath, run } = await timingFixture("kill-timing", 999, {
        collect: queued,
        startedAt: queued ? undefined : 1_000,
        endedAt: 1_500,
        endedReason: "subagent-killed",
        killReconciliation: { killedAt: 1_500 },
      });

      await runSessionMutation({
        scope: storePath,
        identities: [key, session.sessionId],
        diagnosticLabel: "subagent-kill",
        run: () =>
          persistSubagentSessionTiming(run, {
            session: { storePath, entry: session, assertCurrent() {} },
            ...(queued
              ? { settledQueuedCancellation: { storePath, sessionId: session.sessionId } }
              : {}),
          }),
      });

      const persisted = (await readSubagentSessionStore(storePath))[key];
      expect(persisted).toMatchObject({
        sessionId: session.sessionId,
        updatedAt: 999,
        status: "killed",
        endedAt: 1_500,
      });
      expect(persisted?.startedAt).toBe(queued ? undefined : 1_000);
      expect(persisted?.runtimeMs).toBe(queued ? undefined : 500);
      if (queued) {
        expect(persisted?.lastRunId).toBe("run-kill-timing");
      }
    },
  );

  it("normalizes newly registered session keys to canonical trimmed values", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({ status: "pending" });

    await registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      childAgentId: "main",
      sessionEntry: { sessionId: "session-live-child" },
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

  it("reloads waitable swarm collector completions after a gateway restart until retention expires", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    });
    const completedAt = Date.now();
    const run = makeRun("run-swarm-restart", {
      childSessionKey: "agent:worker:subagent:swarm-restart",
      childAgentId: "worker",
      childSessionIdentity: {
        sessionId: "session-swarm-restart",
        lifecycleRevision: "revision-swarm-restart",
      },
      requesterAgentId: "main",
      requesterTurnRunId: "parent-swarm-restart",
      expectsCompletionMessage: false,
      execution: { status: "terminal", endedAt: completedAt },
      cleanupCompletedAt: completedAt,
      archiveAtMs: completedAt + 60_000,
      collect: true,
      swarmRequesterSessionKey: "agent:worker:subagent:owner",
      swarmWaitOwnerSessionKeys: ["agent:worker:subagent:owner", "agent:main:main"],
      groupId: "swarm:agent:main:main:parent-run",
      outputSchema: { type: "object", required: ["answer"] },
      completion: {
        required: false,
        terminalReply: { disposition: "visible", text: "raw answer" },
        resultText: "raw answer",
        capturedAt: completedAt,
      },
      collectorCompletion: {
        status: "done",
        structured: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "worker",
      sessionKey: run.childSessionKey,
      sessionId: "session-swarm-restart",
      lifecycleRevision: "revision-swarm-restart",
      defaultSessionId: "session-swarm-restart",
      updatedAt: run.execution.endedAt,
    });

    await closeOpenClawStateDatabaseAsync();
    const restored = loadSubagentRegistryFromSqlite().get(run.runId);

    expect(restored).toMatchObject({
      collect: true,
      swarmRequesterSessionKey: run.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys: run.swarmWaitOwnerSessionKeys,
      groupId: run.groupId,
      outputSchema: run.outputSchema,
      collectorCompletion: {
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });

    await resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    const gateway = {
      localEmbedded: true,
      recoveryRuntime: createSubagentPersistenceRuntime(callGateway),
      resolveGatewayContext: () => gateway as never,
    };
    await activateSubagentRegistry(gateway.resolveGatewayContext).settled;
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

    let deletionGateway: unknown;
    vi.mocked(callGateway).mockClear();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      deletionGateway = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
      return { ok: true };
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(completedAt + 60_001);
    try {
      await testing.sweepOnceForTests();
    } finally {
      clock.mockRestore();
    }
    expect(deletionGateway).toBe(gateway);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          key: run.childSessionKey,
          agentId: "worker",
          expectedSessionId: "session-swarm-restart",
          expectedLifecycleRevision: "revision-swarm-restart",
        }),
      }),
    );
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([]);
    expect(readPersistedRun(run.runId)).toBeUndefined();
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
    const run = endedRun(runId, {
      childSessionKey,
      childSessionIdentity: { sessionId: `sess-${runId}` },
      cleanup,
    });
    await prepareSubagentRecoveryFixture(run, { stateDir: fixture.stateDir });
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    await writeChildSessionEntry({ sessionKey: childSessionKey, sessionId: `sess-${runId}` });
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
      await waitForRegistry(() => expect(announceSpy).toHaveBeenCalledOnce());
      readiness = waitForRegistry(() => {
        expectDeferredSubagentAnnouncement(readPersistedRun(runId), runId);
      }).then(() => {
        retryReady = true;
      });
      await vi.dynamicImportSettled();
      const held = readPersistedRun(runId);
      // Restart readiness must not release the acknowledged runtime lock.
      expect(held?.cleanupHandled).toBe(false);
      expect((await getSubagentRunByChildSessionKey(childSessionKey))?.cleanupHandled).toBe(true);
      expect([
        held?.delivery?.attemptCount,
        held?.delivery?.payload,
        held?.delivery?.nextAttemptAt,
      ]).toEqual([undefined, undefined, undefined]);
      expect(retryReady).toBe(false);
      releaseAnnouncement();
      await readiness;
      expect(announceSpy).toHaveBeenCalledOnce();
      await fixture.settle();

      announceSpy.mockResolvedValueOnce("delivered");
      const beforeRetry = Date.now();
      await restartRegistry();
      await waitForRegistry(() => expect(settlement.run).toHaveBeenCalledOnce());
      expect(announceSpy).toHaveBeenCalledTimes(2);
      const delivered = readPersistedRun(runId);
      expect(delivered).toMatchObject({
        delivery: { status: "delivered" },
      });
      expect(delivered?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
      expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
      if (cleanup === "delete") {
        expect(delivered?.requesterSettleWake?.retireAfterSettle).toBe(true);
      }
      await settlement.release();
      expect(settlement.run).toHaveBeenCalledOnce();
      const afterSecond = readPersistedRun(runId);
      if (cleanup === "delete") {
        expect(afterSecond).toBeUndefined();
      } else {
        expect(afterSecond?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
      }
    } finally {
      releaseAnnouncement();
      await Promise.all([announcement.promise.catch(() => {}), readiness, settlement.release()]);
    }
  });

  it.each(["restart", "suspension"] as const)(
    "retains an admitted resume read across a %s fence",
    async (fence) => {
      const runId = "admitted-resume-read";
      const entry = runningRun(runId);
      await addSubagentRunForTests(entry);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const parent = tryBeginGatewayRootWorkAdmission("test:resume-parent");
      if (!parent) {
        throw new Error("Expected an admitted resume parent");
      }
      const read = holdSessionRead(entry, true);
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
          expect(resumeSubagentRun(runId)).toBeUndefined();
          parent.release();
          retainedRoots = getActiveGatewayRootWorkCount();
        });
        expect(retainedRoots).toBe(1);
        await read.entered;
        expect(readPersistedRun(runId)?.execution.status).toBe("running");
        read.release();
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
        read.release();
        parent.release();
        if (getActiveGatewayRootWorkCount() === 0) {
          reopen();
        }
        try {
          await fixture.settle();
        } finally {
          reopen();
          read.spy.mockRestore();
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
    let gateway = sessionSharingTestContext(vi.fn());
    const resolveGatewayContext = () => gateway;
    gateway.resolveGatewayContext = resolveGatewayContext;
    if (change === "Gateway replacement") {
      await activateSubagentRegistry(resolveGatewayContext).settled;
    }
    const runId = "held-resume-read";
    const entry = runningRun(runId);
    const now = entry.createdAt;
    await addSubagentRunForTests(entry);
    if (change === "worker read failure") {
      await writeRunSession(entry);
    }
    if (change === "run Gateway replacement") {
      bindGatewayContextResolver(subagentRuns.get(runId)!, resolveGatewayContext);
    }
    const read = holdSessionRead(entry, false, change === "worker read failure");
    let settling: Promise<void> | undefined;
    let restoreLifecycle: (() => void) | undefined;
    let restoreCleanup: (() => void) | undefined;
    try {
      resumeSubagentRun(runId);
      settling = fixture.settle();
      await awaitGateBeforeSettlement(
        read.entered,
        settling,
        "Resume did not reach its admitted worker session read",
      );
      resumeSubagentRun(runId);
      expect(read.reads()).toBe(1);
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
        await writeRunSession(entry);
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
        using capture = vi.spyOn(stateContext, "captureOpenClawStateWorkerContext");
        capture.mockImplementationOnce(() => {
          throw failure;
        });
        expect(() => resumeSubagentRun(runId)).toThrow(failure);
      }
      if (admittedDrain) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const startCleanup = announceCleanup.startSubagentAnnounceCleanupFlow;
        const cleanup = vi
          .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
          .mockImplementationOnce((...args) => {
            using capture = vi.spyOn(stateContext, "captureOpenClawStateWorkerContext");
            capture.mockImplementationOnce(() => {
              throw new Error("Synthetic admitted cleanup capture refusal");
            });
            return startCleanup(...args);
          });
        restoreCleanup = () => cleanup.mockRestore();
        markGatewayRestartDraining();
      }
      read.release();
      if (admittedDrain || change === "worker read failure") {
        await expect(settling).rejects.toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({
              message: admittedDrain
                ? "Synthetic admitted cleanup capture refusal"
                : "Synthetic resume session read failure",
            }),
          ]),
        });
        settling = undefined;
      } else {
        await settling;
      }
      restoreLifecycle?.();
      await fixture.settle();
      if (change === "session publication") {
        expect(read.reads()).toBeGreaterThanOrEqual(2);
        expect(readPersistedRun(runId)?.execution.outcome).toMatchObject({ status: "ok" });
      } else if (change === "worker read failure") {
        expect(callGateway).not.toHaveBeenCalled();
        expect(readPersistedRun(runId)).toEqual(expected);
        resumeSubagentRun(runId);
        await fixture.settle();
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
        expect(read.reads()).toBe(1);
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
      read.release();
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
          read.spy.mockRestore();
        }
      }
    }
  });

  registerSubagentOrphanTaskCases({
    writePersistedRegistry,
    restartRegistry,
    waitForRegistryWork,
  });

  it("resume preserves steer-restart ownership when the child session is missing", async () => {
    const runId = "run-orphan-resume-guard";
    const childSessionKey = "agent:main:subagent:ghost-resume";
    const now = Date.now();

    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    await addSubagentRunForTests(
      makeRun(runId, {
        childSessionKey,
        createdAt: now - 50,
        startedAt: now - 25,
        endedAt: now,
        completion: { required: false },
        delivery: { status: "pending" },
        suppressAnnounceReason: "steer-restart",
        cleanupHandled: false,
      }),
    );
    await removeChildSessionEntry(childSessionKey);

    resumeSubagentRun(runId);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId, suppressAnnounceReason: "steer-restart" }),
    ]);
  });
});
