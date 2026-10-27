import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { announceSpy, createSubagentPersistenceRuntime, useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../../config/sessions/session-entry-current-check.js";
import { callGateway } from "../../../gateway/call.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { runSessionMutation } from "../../../sessions/session-controller.lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunFixture } from "./subagent-registry.persistence.test-support.js";
import {
  createCanonicalSubagentRunFixture,
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

  const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
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
      lifecycleRuntime: createSubagentPersistenceRuntime(callGateway),
      resolveGatewayContext: () => gateway as never,
    };
    await activateSubagentRegistry(gateway.resolveGatewayContext);
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
