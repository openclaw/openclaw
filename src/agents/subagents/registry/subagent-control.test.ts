// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { mockSessionReplacementForStore } from "./subagent-control.leaf-mocks.test-support.js";
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture, useSubagentControlSessionStores } from "./subagent-control.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { stopSubagentsForRequester } from "../../../auto-reply/reply/abort-operation.js";
import { tryFastAbortFromMessage } from "../../../auto-reply/reply/abort.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getActiveSessionLifecycleMutationCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import * as killSession from "./subagent-control-session.js";
import { registerAdmissionDrainControlTests } from "./subagent-control.admission-drain.test-support.js";
import {
  buildControlledSubagentRunsReadContext,
  killAllControlledSubagentRuns,
  killSubagentRunAdmin,
} from "./subagent-control.js";
import { registerLateDescendantControlTests } from "./subagent-control.late-registration.test-support.js";
import { registerQueuedReservationFailureTests } from "./subagent-control.queued-failure.test-support.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./subagent-control.types.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { replaceSubagentRunAfterSteerCore, startQueuedSubagentRun } from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture();
const { cfgWithSessionStore, writeSessionStoreFixture } = useSubagentControlSessionStores();

type ControlRuntime = typeof import("./subagent-control.runtime.js");

const controlRuntimeMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<ControlRuntime["abortEmbeddedAgentRun"]>(() => false),
  isEmbeddedAgentRunActive: vi.fn<ControlRuntime["isEmbeddedAgentRunActive"]>(() => false),
  clearSessionLifecycleQueues: vi.fn<ControlRuntime["clearSessionLifecycleQueues"]>(() => ({
    followupCleared: 0,
    laneCleared: 0,
    keys: [],
  })),
}));

vi.mock("./subagent-control.runtime.js", () => controlRuntimeMocks);

function setSubagentControlDepsForTest(overrides: Partial<ControlRuntime> = {}) {
  const { isEmbeddedAgentRunActive: isActive, clearSessionLifecycleQueues: clearQueues } =
    overrides;
  controlRuntimeMocks.abortEmbeddedAgentRun.mockReset();
  controlRuntimeMocks.isEmbeddedAgentRunActive.mockReset();
  controlRuntimeMocks.clearSessionLifecycleQueues.mockReset();
  // Default to the canonical store; individual race tests replace only their fault boundary.
  vi.mocked(applySessionEntryExactReplacements).mockReset();
  if (overrides.abortEmbeddedAgentRun) {
    controlRuntimeMocks.abortEmbeddedAgentRun.mockImplementation(overrides.abortEmbeddedAgentRun);
  }
  if (isActive) {
    controlRuntimeMocks.isEmbeddedAgentRunActive.mockImplementation(isActive);
  }
  if (clearQueues) {
    controlRuntimeMocks.clearSessionLifecycleQueues.mockImplementation(clearQueues);
  }
}

function controllerFor(controllerSessionKey = "agent:main:main") {
  return {
    controllerSessionKey,
    callerSessionKey: controllerSessionKey,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
}

function resetRegistryLeafMocks() {
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
  vi.mocked(ensureContextEnginesInitialized).mockReset();
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
  fixture.worker.mockReset().mockImplementation(runSubagentStateWorkerOperation);
  vi.mocked(resolveContextEngine).mockReset();
}

beforeEach(() => {
  setSubagentControlDepsForTest();
  resetRegistryLeafMocks();
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockResolvedValue(undefined);
  vi.mocked(ensureContextEnginesInitialized).mockResolvedValue(undefined);
  vi.mocked(resolveContextEngine).mockImplementation(async () => ({
    info: { id: "test", name: "Test" },
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    ingest: async () => ({ ingested: false }),
  }));
});

async function addRun(overrides: SubagentRunRecordOverrides) {
  await addSubagentRunForTests({
    controllerSessionKey: "agent:main:main",
    createdAt: Date.now() - 5_000,
    startedAt: Date.now() - 4_000,
    ...overrides,
  });
  return subagentRuns.get(overrides.runId)!;
}

function writeSession(label: string, sessionKey: string, entry: Partial<SessionEntry>) {
  return writeSessionStoreFixture(label, { [sessionKey]: entry });
}

function onPersistenceWrite(beforeWrite: () => void) {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          ...scope,
          execute: async (command) => {
            if (command.type === "subagents.persistChanges") {
              beforeWrite();
            }
            return scope.execute(command);
          },
        }),
      options,
    ),
  );
}

function publishRun(runId: string, update: (current: SubagentRunRecord) => SubagentRunRecord) {
  return mutateSubagentRuns([runId], (rows) => ({
    value: undefined,
    postimages: new Map([[runId, update(rows.get(runId)!)]]),
  }));
}

describe("killSubagentRunAdmin", () => {
  it("does not mark a finalizing run killed when its abort is rejected", async () => {
    const childSessionKey = "agent:main:subagent:worker-finalizing";
    const runId = "run-worker-finalizing";
    const storePath = await writeSession("admin-kill-finalizing", childSessionKey, {
      sessionId: "sess-worker-finalizing",
      updatedAt: Date.now(),
    });
    await addRun({
      runId,
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "finish the reply",
    });
    setSubagentControlDepsForTest({ isEmbeddedAgentRunActive: () => true });
    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });
    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId,
      sessionKey: childSessionKey,
    });
    expect(
      (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun,
    ).toBeUndefined();
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it.each([
    {
      identity: "run ID",
      runId: "run-current",
      suffix: "replacement",
      generation: undefined,
      constraints: [{ expectedRunId: "run-stale" }],
    },
    {
      identity: "generation or owner",
      runId: "run-reused",
      suffix: "same-id-replacement",
      generation: 2,
      constraints: [
        { expectedRunId: "run-reused", expectedGeneration: 1, expectedOwnerKey: "agent:main:main" },
        {
          expectedRunId: "run-reused",
          expectedGeneration: 2,
          expectedOwnerKey: "agent:main:other",
        },
      ],
    },
  ])(
    "does not kill a replacement with a mismatched $identity",
    async ({ runId, suffix, generation, constraints }) => {
      const childSessionKey = `agent:main:subagent:${suffix}`;
      await addRun({
        runId,
        childSessionKey,
        task: "replacement work",
        generation,
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 900,
      });
      for (const expected of constraints) {
        expect(
          await killSubagentRunAdmin({
            cfg: cfgWithSessionStore(),
            sessionKey: childSessionKey,
            ...expected,
          }),
        ).toEqual({ found: false, killed: false });
      }
      expect(
        (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
      ).toBeUndefined();
    },
  );

  it("does not adopt a restart-recovery successor when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:fenced-recovery-successor";
    const sessionId = "sess-fenced-recovery-successor";
    const recoveryRunId = "run-fenced-recovery-successor";
    const receipt = {
      sessionId,
      sessionMarker: `${sessionId}:1`,
      idempotencyKey: recoveryRunId,
      phase: "accepted" as const,
    };
    const source = await addRun({
      runId: "run-fenced-recovery-source",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "source recovery task",
      completion: { required: false },
      delivery: { status: "pending" },
      generation: 1,
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: receipt,
      },
    });
    const storePath = await writeSession("fenced-recovery-successor", childSessionKey, {
      sessionId,
      updatedAt: Date.now(),
      abortedLastRun: true,
    });
    const interrupted = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => interrupted.resolve(),
    });
    const handoffId = admission.createHandoff();
    const abort = vi.fn(() => true);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: abort,
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
      expectedRunId: source.runId,
    });
    let adopted: ReturnType<typeof consumeSessionWorkAdmissionHandoff>;
    try {
      await interrupted.promise;
      expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);
      adopted = consumeSessionWorkAdmissionHandoff({
        handoffId,
        scope: storePath,
        identities: [childSessionKey, sessionId],
        onInterrupt: () => undefined,
      });
      expect(
        await replaceSubagentRunAfterSteerCore({
          previousRunId: source.runId,
          nextRunId: recoveryRunId,
          expected: source,
        }),
      ).toBe(true);
      expect(adopted).toBeDefined();
      adopted?.release();

      await expect(pendingKill).resolves.toMatchObject({
        found: true,
        killed: false,
        runId: source.runId,
      });
      expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: recoveryRunId,
        execution: { status: "running" },
      });
      expect(
        (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
      ).toBeUndefined();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      adopted?.release();
      admission.release();
      await pendingKill;
    }
  });

  it("does not retarget a same-id recovery successor in the admin path", async () => {
    const childSessionKey = "agent:main:subagent:admin-same-id-successor";
    const runId = "run-admin-same-id";
    const source = await addRun({
      runId,
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "admin source",
      generation: 1,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: {
          sessionId: "sess-fenced-same-id-successor",
          sessionMarker: "sess-fenced-same-id-successor:1",
          idempotencyKey: runId,
          phase: "accepted",
        },
      },
    });
    const abort = controlRuntimeMocks.abortEmbeddedAgentRun;

    const replacementReady = createDeferred();
    let replacementPending = true;
    const pendingKill = killSubagentRunAdmin(
      {
        cfg: cfgWithSessionStore(),
        sessionKey: childSessionKey,
        expectedRunId: runId,
      },
      {
        assertCurrent: () => {},
        prepareRead: () => (replacementPending ? replacementReady.promise : undefined),
      },
    );
    await addRun({
      ...source,
      task: "admin successor",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });

    replacementPending = false;
    replacementReady.resolve();
    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId,
    });
    expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId,
      generation: 2,
      execution: { status: "running" },
    });
    expect(
      (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
    ).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("keeps a killed steer-restart run on its failed projection", async () => {
    const childSessionKey = "agent:main:subagent:steer-restart";
    const endedAt = Date.now() - 1_000;
    await addRun({
      runId: "run-steer-restart",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "replace active run",
      createdAt: endedAt - 4_000,
      startedAt: endedAt - 3_000,
      endedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      suppressAnnounceReason: "steer-restart",
      outcome: { status: "error", error: "agent run aborted" },
      completion: { required: false, resultText: null, capturedAt: endedAt },
    });

    const result = await killSubagentRunAdmin({ cfg: {}, sessionKey: childSessionKey });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: {
          status: "failed",
          endedAt,
          error: "agent run aborted",
        },
      },
    });
  });

  it.each([
    {
      name: "restores the recoverable task marker when abort lifecycle wins the race",
      suffix: "abort-lifecycle-race",
      task: "finish while aborting",
      completed: false,
    },
    {
      name: "reports when completion wins while the kill path awaits persistence",
      suffix: "completion-race",
      task: "finish while cancellation starts",
      completed: true,
    },
  ])("$name", async ({ suffix, task, completed }) => {
    const childSessionKey = `agent:main:subagent:${suffix}`;
    const current: SessionEntry = { sessionId: `sess-${suffix}`, updatedAt: Date.now() };
    const storePath = await writeSession(`admin-kill-${suffix}`, childSessionKey, current);
    const input = createSubagentRunRecord({
      runId: `run-${suffix}`,
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    if (completed) {
      await addRun({
        ...input,
        runId: "run-stale-completion-race",
        task: "stale older row",
        createdAt: Date.now() - 9_000,
        execution: { status: "running", startedAt: Date.now() - 8_000 },
      });
    }
    const run = await addRun(input);
    const abortedLastRunWrites: boolean[] = [];
    let terminalPublication = Promise.resolve();
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        terminalPublication = publishRun(run.runId, (row) => ({
          ...row,
          ...(completed
            ? {
                endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
                completion: { required: false, resultText: "done", capturedAt: endedAt },
              }
            : {
                endedReason: SUBAGENT_ENDED_REASON_KILLED,
                suppressAnnounceReason: "killed",
                killReconciliation: { killedAt: endedAt },
              }),
          execution: {
            ...row.execution,
            status: "terminal",
            endedAt,
            outcome: completed ? { status: "ok" } : { status: "error", error: "agent run aborted" },
          },
        }));
        return true;
      },
    });
    mockSessionReplacementForStore(storePath, async (params) => {
      const operation = await params.update([{ sessionKey: childSessionKey, entry: current }]);
      params.assertCommitAllowed?.();
      const replacement = [...(operation.replacements ?? [])][0]?.entry;
      if (replacement && replacement.abortedLastRun !== current.abortedLastRun) {
        abortedLastRunWrites.push(replacement.abortedLastRun === true);
      }
      return operation.result;
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });
    await terminalPublication;
    expect(result).toMatchObject({ found: true, killed: !completed });
    expect(abortedLastRunWrites).toEqual(completed ? [] : [true]);
    if (completed) {
      expect(result).toMatchObject({
        targetState: {
          state: "terminal",
          task: { status: "succeeded", endedAt: expect.any(Number) },
        },
        runId: "run-completion-race",
      });
      expect(subagentRuns.get(run.runId)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: { outcome: { status: "ok" } },
      });
    }
  });

  it("refreshes target completion after descendant cancellation settles", async () => {
    const childSessionKey = "agent:main:subagent:cascade-completion-race";
    const descendantSessionKey = "agent:main:subagent:cascade-completion-child";
    const storePath = await writeSessionStoreFixture("admin-kill-cascade-completion-race", {
      [childSessionKey]: {
        sessionId: "sess-cascade-completion-race",
        updatedAt: Date.now(),
      },
      [descendantSessionKey]: {
        sessionId: "sess-cascade-completion-child",
        updatedAt: Date.now(),
      },
    });
    const run = await addRun({
      runId: "run-cascade-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while descendant cancellation settles",
    });
    const abortedLastRunWrites: boolean[] = [];
    await addRun({
      runId: "run-cascade-completion-child",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: "parent",
      task: "descendant",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });
    let terminalPublication = Promise.resolve();
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
    });
    mockSessionReplacementForStore(storePath, async (params) => {
      const sessionKey = params.activeSessionKey!;
      const current = loadSessionEntry({ storePath: params.storePath, sessionKey, clone: false });
      const operation = await params.update(current ? [{ sessionKey, entry: current }] : []);
      params.assertCommitAllowed?.();
      const replacement = [...(operation.replacements ?? [])][0]?.entry;
      if (
        sessionKey === childSessionKey &&
        replacement &&
        replacement.abortedLastRun !== current?.abortedLastRun
      ) {
        abortedLastRunWrites.push(replacement.abortedLastRun === true);
      }
      if (sessionKey === descendantSessionKey) {
        const endedAt = Date.now();
        terminalPublication = publishRun(run.runId, (currentRun) => ({
          ...currentRun,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          completion: { required: false, resultText: "done", capturedAt: endedAt },
          execution: {
            ...currentRun.execution,
            status: "terminal",
            endedAt,
            outcome: { status: "ok" },
          },
        }));
      }
      await terminalPublication;
      return operation.result;
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    await terminalPublication;
    expect(result).toMatchObject({
      found: true,
      killed: true,
      targetState: {
        state: "terminal",
        task: {
          status: "succeeded",
        },
      },
    });
    expect(abortedLastRunWrites).toEqual([true, false]);
  });

  it("kills a run that yields while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:yield-race";
    const storePath = await writeSession("admin-kill-yield-race", childSessionKey, {
      sessionId: "sess-yield-race",
      updatedAt: Date.now(),
    });
    const run = await addRun({
      runId: "run-yield-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "yield while cancellation starts",
    });
    const yieldedAt = Date.now() - 1_000;
    let terminalPublication = Promise.resolve();
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        terminalPublication = publishRun(run.runId, (current) => ({
          ...current,
          execution: {
            ...current.execution,
            status: "terminal",
            endedAt: yieldedAt,
          },
          pauseReason: "sessions_yield",
        }));
        return true;
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    await terminalPublication;
    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-yield-race",
      targetState: {
        state: "terminal",
        task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
      },
    });
    expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        endedAt: yieldedAt,
        outcome: {
          status: "error",
          endedAt: yieldedAt,
          elapsedMs: yieldedAt - (run.execution.startedAt ?? yieldedAt),
        },
      },
    });
    expect((await getSubagentRunByChildSessionKey(childSessionKey))?.pauseReason).toBeUndefined();
    const killedAt =
      result.found && result.targetState?.state === "terminal"
        ? result.targetState.task.endedAt
        : undefined;
    expect(killedAt).toBeGreaterThan(yieldedAt);

    const repeated = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });
    expect(repeated).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: { status: "cancelled", endedAt: killedAt },
      },
    });
  });

  it("does not kill a newest finalizing run when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:worker-stale-admin";

    await addRun({
      runId: "run-stale-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "stale admin task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    await addRun({
      runId: "run-current-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "current admin task",
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-current-admin",
      sessionKey: childSessionKey,
    });
    expect(result.found && result.targetState).toEqual({ state: "finalizing" });
  });
});

describe("controlled subagent cancellation races", () => {
  it("does not let 24 in-flight kills cross into same-id successor generations", async () => {
    const count = 24;
    const controllerSessionKey = "agent:main:main";
    const oldRuns = Array.from({ length: count }, (_, index) =>
      createSubagentRunRecord({
        runId: `run-old-${index}`,
        childSessionKey: `agent:main:subagent:generation-race-${index}`,
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: `old task ${index}`,
        generation: 1,
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      }),
    );
    const storePath = await writeSessionStoreFixture(
      "generation-race",
      Object.fromEntries(
        oldRuns.map((entry, index) => [
          entry.childSessionKey,
          { sessionId: `sess-generation-race-${index}`, updatedAt: Date.now() },
        ]),
      ),
    );
    for (const [index, entry] of oldRuns.entries()) {
      oldRuns[index] = await addRun(entry);
    }

    const {
      isEmbeddedAgentRunActive: isActive,
      abortEmbeddedAgentRun: abort,
      clearSessionLifecycleQueues: clearQueues,
    } = controlRuntimeMocks;

    const replacementsReady = createDeferred();
    const killsEntered = oldRuns.map(() => createDeferred());
    const pendingKills = oldRuns.map((entry, index) =>
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(controllerSessionKey),
        runs: [entry],
        beforeKill: async () => {
          killsEntered[index]!.resolve();
          await replacementsReady.promise;
          return true;
        },
      }),
    );

    await Promise.all(killsEntered.map((entered) => entered.promise));
    const successorKeys: string[] = [];
    const descendantKeys: string[] = [];
    for (const [index, entry] of oldRuns.entries()) {
      successorKeys.push(entry.childSessionKey);
      descendantKeys.push(`${entry.childSessionKey}:subagent:leaf`);
      await addRun({
        ...entry,
        runId: entry.runId,
        task: `successor task ${index}`,
        generation: 2,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      await addRun({
        ...entry,
        runId: `run-successor-leaf-${index}`,
        childSessionKey: descendantKeys[index]!,
        controllerSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.childSessionKey,
        requesterDisplayKey: entry.childSessionKey,
        task: `successor leaf ${index}`,
        generation: 1,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
    }

    replacementsReady.resolve();
    const results = await Promise.all(pendingKills);

    expect(results.every((result) => result.status === "ok" && result.killed === 0)).toBe(true);
    expect(isActive).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    for (const [index, childSessionKey] of successorKeys.entries()) {
      expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: `run-old-${index}`,
        controllerSessionKey,
        generation: 2,
        execution: { status: "running" },
      });
      expect(
        (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
      ).toBeUndefined();
      expect(await getSubagentRunByChildSessionKey(descendantKeys[index]!)).toMatchObject({
        runId: `run-successor-leaf-${index}`,
        execution: { status: "running" },
      });
      expect(
        (await getSubagentRunByChildSessionKey(descendantKeys[index]!))?.execution.endedAt,
      ).toBeUndefined();
    }
  });

  it("fences a successor that appears while kill persistence is pending", async () => {
    const childSessionKey = "agent:main:subagent:persist-generation-race";
    const descendantSessionKey = `${childSessionKey}:subagent:leaf`;
    const controllerSessionKey = "agent:main:main";
    const oldRunFixture = createSubagentRunRecord({
      runId: "run-persist-old",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "old persisted task",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const storePath = await writeSession("persist-generation-race", childSessionKey, {
      sessionId: "sess-persist-generation-race",
      updatedAt: Date.now(),
    });
    const oldRun = await addRun(oldRunFixture);

    const persistenceStarted = createDeferred();
    const persistenceRelease = createDeferred();
    const persistMarker = killSession.persistSubagentAbortedLastRun;
    using markerSpy = vi.spyOn(killSession, "persistSubagentAbortedLastRun");
    markerSpy.mockImplementation(async (params) => {
      if (params.childSessionKey === childSessionKey && params.abortedLastRun) {
        persistenceStarted.resolve();
        await persistenceRelease.promise;
      }
      return persistMarker(params);
    });

    const pendingKill = killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(controllerSessionKey),
      runs: [oldRun],
    });
    try {
      await persistenceStarted.promise;

      await addRun({
        ...oldRunFixture,
        runId: "run-persist-successor",
        controllerSessionKey: "agent:foreign:controller",
        requesterSessionKey: "agent:foreign:controller",
        requesterDisplayKey: "agent:foreign:controller",
        task: "successor persisted task",
        generation: 2,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      await addRun({
        ...oldRunFixture,
        runId: "run-persist-successor-leaf",
        childSessionKey: descendantSessionKey,
        controllerSessionKey: childSessionKey,
        requesterSessionKey: childSessionKey,
        requesterDisplayKey: childSessionKey,
        task: "successor persisted leaf",
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
    } finally {
      persistenceRelease.resolve();
      await pendingKill;
    }

    await expect(pendingKill).resolves.toMatchObject({
      status: "ok",
      killed: 1,
      labels: ["old persisted task"],
    });
    expect(controlRuntimeMocks.abortEmbeddedAgentRun).toHaveBeenCalledOnce();
    expect(controlRuntimeMocks.clearSessionLifecycleQueues).toHaveBeenCalledOnce();
    for (const [sessionKey, runId] of [
      [childSessionKey, "run-persist-successor"],
      [descendantSessionKey, "run-persist-successor-leaf"],
    ] as const) {
      const successor = await getSubagentRunByChildSessionKey(sessionKey);
      expect(successor).toMatchObject({ runId, execution: { status: "running" } });
      expect(successor?.execution.endedAt).toBeUndefined();
    }
  });

  it("does not abort or clear queues after the child session incarnation resets", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-reset";
    const storePath = await writeSession("kill-session-reset", childSessionKey, {
      sessionId: "sess-kill-session-reset",
      lifecycleRevision: "revision-before-reset",
      updatedAt: Date.now(),
    });
    const entry = await addRun({
      runId: "run-kill-session-reset",
      childSessionKey,
      task: "old session work",
    });
    const abort = vi.fn(() => true);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => {
        replaceSessionEntrySync(
          { storePath, sessionKey: childSessionKey },
          {
            sessionId: "sess-kill-session-reset",
            lifecycleRevision: "revision-after-reset",
            updatedAt: Date.now(),
          },
        );
        return true;
      },
      abortEmbeddedAgentRun: abort,
      clearSessionLifecycleQueues: clearQueues,
    });

    await expect(
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(),
        runs: [entry],
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: "old session work: Subagent session changed while the kill was pending; retry.",
    });

    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: undefined,
      execution: { status: "running" },
    });
  });

  it("does not patch the replacement session after the killed row commits", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-patch-reset";
    const storePath = await writeSession("kill-session-patch-reset", childSessionKey, {
      sessionId: "sess-kill-session-patch-reset",
      lifecycleRevision: "revision-before-reset",
      updatedAt: Date.now(),
    });
    const entry = await addRun({
      runId: "run-kill-session-patch-reset",
      childSessionKey,
      task: "do not patch successor",
    });
    const patches: Array<Partial<SessionEntry> | null> = [];
    mockSessionReplacementForStore(storePath, async (params) => {
      const replacement: SessionEntry = {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-after-reset",
        updatedAt: Date.now(),
      };
      const operation = await params.update([{ sessionKey: childSessionKey, entry: replacement }]);
      params.assertCommitAllowed?.();
      patches.push([...(operation.replacements ?? [])][0]?.entry ?? null);
      return operation.result;
    });

    await expect(
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(),
        runs: [entry],
      }),
    ).resolves.toMatchObject({ status: "ok", killed: 1 });

    expect(patches).toEqual([null, null]);
    expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it("kills a yielded descendant without reviving a stale child row", async () => {
    const parentSessionKey = "agent:main:subagent:kill-parent";
    const childSessionKey = `${parentSessionKey}:subagent:child`;
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const parentRun = await addRun({
      runId: "run-parent-current",
      childSessionKey: parentSessionKey,
      task: "current parent task",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    await addRun({
      runId: "run-child-stale",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "stale child task",
    });
    await addRun({
      runId: "run-child-current",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "current child task",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_500,
      outcome: { status: "ok" },
    });
    await addRun({
      runId: "run-leaf-active",
      childSessionKey: leafSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
      endedAt: Date.now() - 800,
      pauseReason: "sessions_yield",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: controllerFor(),
      runs: [parentRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["leaf task"],
    });
    expect((await getSubagentRunByChildSessionKey(leafSessionKey))?.execution.endedAt).toBeTypeOf(
      "number",
    );
  });

  it("does not cascade through a child session that moved to a newer parent", async () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const oldParentRun = await addRun({
      runId: "run-old-parent-current",
      childSessionKey: oldParentSessionKey,
      task: "old parent task",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    await addRun({
      runId: "run-new-parent-current",
      childSessionKey: newParentSessionKey,
      task: "new parent task",
    });
    await addRun({
      runId: "run-child-stale-old-parent",
      childSessionKey,
      controllerSessionKey: oldParentSessionKey,
      requesterSessionKey: oldParentSessionKey,
      requesterDisplayKey: oldParentSessionKey,
      task: "stale shared child task",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_500,
      endedAt: Date.now() - 3_000,
      outcome: { status: "ok" },
    });
    await addRun({
      runId: "run-child-current-new-parent",
      childSessionKey,
      controllerSessionKey: newParentSessionKey,
      requesterSessionKey: newParentSessionKey,
      requesterDisplayKey: newParentSessionKey,
      task: "current shared child task",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_500,
    });
    await addRun({
      runId: "run-leaf-active",
      childSessionKey: leafSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: controllerFor(),
      runs: [oldParentRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    expect(
      (await getSubagentRunByChildSessionKey(leafSessionKey))?.execution.endedAt,
    ).toBeUndefined();
  });

  it("interrupts a pending recovery admission before deciding the kill target is inactive", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-recovery-admission";
    const sessionId = "sess-kill-recovery-admission";
    const entry = await addRun({
      runId: "run-kill-recovery-admission",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "kill recovery admission",
      createdAt: Date.now() - 2_000,
      execution: { status: "running", startedAt: Date.now() - 1_000 },
    });
    const storePath = await writeSession("kill-recovery-admission", childSessionKey, {
      sessionId,
      updatedAt: Date.now(),
      abortedLastRun: true,
    });
    const interrupted = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => interrupted.resolve(),
    });
    const handoffId = admission.createHandoff();
    let recoveryActive = false;
    const abort = vi.fn(() => recoveryActive);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => recoveryActive,
      abortEmbeddedAgentRun: abort,
    });

    const pendingKill = killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(controllerSessionKey),
      runs: [entry],
    });
    let adopted: ReturnType<typeof consumeSessionWorkAdmissionHandoff>;
    try {
      await interrupted.promise;
      expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);
      adopted = consumeSessionWorkAdmissionHandoff({
        handoffId,
        scope: storePath,
        identities: [childSessionKey, sessionId],
        onInterrupt: () => {
          recoveryActive = true;
        },
      });
      expect(adopted).toBeDefined();
      expect(recoveryActive).toBe(true);
      adopted?.release();

      await expect(pendingKill).resolves.toMatchObject({ status: "ok" });
      expect(abort).toHaveBeenCalledWith(sessionId);
      expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        execution: { status: "terminal" },
      });
    } finally {
      adopted?.release();
      admission.release();
      await pendingKill;
    }
  });

  registerAdmissionDrainControlTests({
    cfgWithSessionStore,
    controllerFor,
    setSubagentControlDepsForTest,
    writeSessionStoreFixture,
  });

  it("leaves restart recovery disabled when the kill tombstone cannot persist", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-tombstone-failure";
    const sessionId = "sess-kill-tombstone-failure";
    const entry = await addRun({
      runId: "run-kill-tombstone-failure",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "kill tombstone failure",
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: {
          sessionId,
          sessionMarker: `${sessionId}:1`,
          idempotencyKey: "recovery-kill-tombstone-failure",
          phase: "reserved",
        },
      },
    });
    const storePath = await writeSession("kill-tombstone-failure", childSessionKey, {
      sessionId,
      updatedAt: 1,
      abortedLastRun: true,
    });
    const abortedLastRunWrites: boolean[] = [];
    let persistenceWrites = 0;
    mockSessionReplacementForStore(storePath, async (params) => {
      const current = { sessionId, updatedAt: 1, abortedLastRun: true };
      const operation = await params.update([{ sessionKey: childSessionKey, entry: current }]);
      for (const { entry: replacement } of operation.replacements ?? []) {
        abortedLastRunWrites.push(replacement.abortedLastRun === true);
      }
      return operation.result;
    });
    resetRegistryLeafMocks();
    onPersistenceWrite(() => {
      if (++persistenceWrites === 2) {
        throw new Error("sqlite busy");
      }
    });

    await expect(
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(controllerSessionKey),
        runs: [entry],
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Failed to persist subagent kill tombstone"),
    });

    expect(abortedLastRunWrites).toEqual([]);
    expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: { reason: "killed", sessionId },
      execution: {
        status: "interrupted",
        restartRecovery: { phase: "reserved" },
      },
    });
    expect(
      (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
    ).toBeUndefined();
  });
});

describe("killAllControlledSubagentRuns", () => {
  registerLateDescendantControlTests({
    cfgWithSessionStore,
    setSubagentControlDepsForTest,
    writeSessionStoreFixture,
  });

  it.each(["first cancellation await", "admin tree", "channel stop"])(
    "does not dispatch selected queued work during %s cancellation",
    async (kind) => {
      const controllerSessionKey = "agent:main:main";
      const runningFixture = createSubagentRunRecord({
        runId: "running-collector",
        childSessionKey: "agent:main:subagent:running-collector",
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "running collector",
        collect: true,
        createdAt: 1,
        startedAt: 2,
      });
      const queuedFixture = createSubagentRunRecord({
        ...runningFixture,
        runId: "queued-collector",
        childSessionKey: "agent:main:subagent:queued-collector",
        controllerSessionKey: kind.endsWith("tree")
          ? runningFixture.childSessionKey
          : controllerSessionKey,
        requesterSessionKey: kind.endsWith("tree")
          ? runningFixture.childSessionKey
          : controllerSessionKey,
        execution: { status: "queued" },
        swarmLaunchPending: true,
      });
      const running = await addRun(runningFixture);
      const queued = await addRun(queuedFixture);
      const storePath = await writeSessionStoreFixture("abort-dispatch", {
        [running.childSessionKey]: { sessionId: "running-session", updatedAt: 1 },
      });
      const started: string[] = [];
      for (const runId of [queued.runId, "unselected"]) {
        enqueueSwarmRun({
          groupId: "cancelled-group",
          runId,
          maxConcurrent: 1,
          activeRunIds: [running.runId],
          start: async () => {
            started.push(runId);
          },
          onStartFailure: () => true,
        });
      }
      setSubagentControlDepsForTest({
        isEmbeddedAgentRunActive: () => true,
        abortEmbeddedAgentRun: (sessionId) => {
          expect(sessionId).toBe("running-session");
          if (kind !== "channel stop" && kind !== "first cancellation await") {
            expect(releaseSwarmRun(running.runId)).toBe(true);
          }
          return true;
        },
      });
      const controller = { ...controllerFor(controllerSessionKey), controllerAgentId: "main" };
      const cfg = cfgWithSessionStore(storePath);
      const parent =
        kind === "channel stop"
          ? createReplyOperation({
              sessionKey: controllerSessionKey,
              sessionId: "parent-session",
              resetTriggered: false,
            })
          : undefined;
      parent?.attachBackend({
        kind: "embedded",
        cancel: () => {
          expect(releaseSwarmRun(running.runId)).toBe(true);
        },
        isStreaming: () => true,
      });
      try {
        if (kind === "first cancellation await") {
          const cancellation = killAllControlledSubagentRuns({
            cfg,
            controller,
            runs: [running, queued],
          });
          // Natural terminal cleanup calls this same capacity owner while kill
          // admission is pending; no synthetic execution outcome is needed.
          expect(releaseSwarmRun(running.runId)).toBe(true);
          expect(await cancellation).toMatchObject({ status: "ok", killed: 2 });
        } else if (kind === "admin tree") {
          expect(
            await killSubagentRunAdmin({
              cfg,
              sessionKey: running.childSessionKey,
              expectedRunId: running.runId,
              expectedGeneration: running.generation,
              expectedOwnerKey: controllerSessionKey,
            }),
          ).toMatchObject({ found: true, killed: true, cascadeKilled: 1 });
        } else {
          expect(
            await tryFastAbortFromMessage({
              cfg,
              ctx: buildTestCtx({
                CommandBody: "/stop",
                RawBody: "/stop",
                CommandAuthorized: true,
                Provider: "telegram",
                Surface: "telegram",
                SessionKey: controllerSessionKey,
                From: "telegram:queue-owner",
                To: "telegram:queue-owner",
              }),
            }),
          ).toMatchObject({ handled: true, stoppedSubagents: 2, failedSubagents: 0 });
          expect(parent?.abortSignal.aborted).toBe(true);
        }
        for (const entry of [running, queued]) {
          expect(await getSubagentRunByChildSessionKey(entry.childSessionKey)).toMatchObject({
            execution: { status: "terminal" },
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
          });
        }
        expect(
          started,
          "selected queued child must never dispatch during cancellation",
        ).not.toContain(queued.runId);
        await vi.waitFor(() => expect(started).toEqual(["unselected"]));
      } finally {
        parent?.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );

  registerQueuedReservationFailureTests({
    cfgWithSessionStore,
    setSubagentControlDepsForTest,
    writeSessionStoreFixture,
    resetRegistryLeafMocks,
  });

  it("preserves exactRunId authority when an in-flight launch remaps the same row", async () => {
    const runId = "launch-before-admission";
    const childSessionKey = "agent:main:subagent:launch-remap";
    const controllerSessionKey = "agent:main:main";
    await addRun({
      runId,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "launch remap",
      createdAt: 1,
      collect: true,
      swarmLaunchPending: true,
      schedulerSlotId: runId,
      execution: { status: "queued" },
    });
    const sessionId = "launch-remap-session";
    const storePath = await writeSession("launch-remap", childSessionKey, {
      sessionId,
      updatedAt: 1,
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const response = createDeferred();
    const started = createDeferred();
    const launchDone = createDeferred();
    const lease = consumeSessionWorkAdmissionHandoff({
      handoffId: admission.createHandoff(),
      scope: storePath,
      identities: [childSessionKey, sessionId],
      onInterrupt: () => response.resolve(),
    });
    enqueueSwarmRun({
      groupId: "remapping",
      runId,
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.resolve();
        try {
          await response.promise;
          expect(await startQueuedSubagentRun(runId, "accepted-launch")).toBe(true);
        } finally {
          lease?.release();
          launchDone.resolve();
        }
      },
      onStartFailure: () => true,
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
    });
    try {
      await started.promise;
      const cfg = cfgWithSessionStore(storePath);
      expect(
        await killSubagentRunAdmin({ cfg, sessionKey: childSessionKey, expectedRunId: runId }),
      ).toMatchObject({ killed: true });
      expect(controlRuntimeMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
      expect((await getSubagentRunByChildSessionKey(childSessionKey))?.runId).toBe(
        "accepted-launch",
      );
    } finally {
      response.resolve();
      await launchDone.promise;
      lease?.release();
      swarmSchedulerTesting.reset();
    }
  });

  it("checks controller agent identity before holding or cancelling bare-session children", async () => {
    const entries = ["main", "work"].map((requesterAgentId) =>
      createSubagentRunRecord({
        runId: `agent-owned-${requesterAgentId}`,
        childSessionKey: `agent:${requesterAgentId}:subagent:worker`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId,
        requesterDisplayKey: "global",
        task: requesterAgentId,
        createdAt: 1,
        collect: true,
        execution: { status: "queued" },
      }),
    );
    const started: string[] = [];
    for (const [index, entry] of entries.entries()) {
      entries[index] = await addRun(entry);
    }
    for (const entry of entries) {
      enqueueSwarmRun({
        groupId: entry.runId,
        runId: entry.runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          started.push(entry.requesterAgentId!);
        },
        onStartFailure: () => true,
      });
    }
    try {
      const result = await killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "global",
          controllerAgentId: "main",
          callerSessionKey: "global",
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: entries,
        beforeKill: async () => {
          await Promise.resolve();
          expect(started).toEqual(["work"]);
          return true;
        },
      });
      expect(result).toMatchObject({ killed: 1, labels: ["main"] });
      expect(started).toEqual(["work"]);
    } finally {
      swarmSchedulerTesting.reset();
    }
  });

  it("continues channel stop cancellation after one registry persistence failure", async () => {
    let failNextPersistence = true;
    const firstFixture = createSubagentRunRecord({
      runId: "run-bulk-persistence-failure-first",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-first",
      controllerSessionKey: "agent:main:main",
      task: "first bulk task",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_900,
    });
    const secondFixture = createSubagentRunRecord({
      ...firstFixture,
      runId: "run-bulk-persistence-failure-second",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-second",
      task: "second bulk task",
      createdAt: Date.now() - 1_000,
      execution: { status: "running", startedAt: Date.now() - 900 },
    });
    const first = await addRun(firstFixture);
    const second = await addRun(secondFixture);
    onPersistenceWrite(() => {
      if (failNextPersistence) {
        failNextPersistence = false;
        throw new Error("sqlite busy");
      }
    });

    expect(
      await stopSubagentsForRequester({
        cfg: cfgWithSessionStore(),
        requesterSessionKey: "agent:main:main",
      }),
    ).toEqual({ stopped: 1, failed: 1 });
    expect(
      (await getSubagentRunByChildSessionKey(first.childSessionKey))?.execution.endedAt,
    ).toBeUndefined();
    expect(
      (await getSubagentRunByChildSessionKey(second.childSessionKey))?.execution.endedAt,
    ).toBeTypeOf("number");
  });

  it("does not let a stale bulk entry suppress the current yielded entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = await writeSession("stale-kill-all-shadow", childSessionKey, {
      updatedAt: Date.now(),
    });

    await addRun({
      runId: "run-stale-shadow",
      childSessionKey,
      task: "stale shadow task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    const stale = subagentRuns.get("run-stale-shadow")!;
    const currentShadowRun = await addRun({
      runId: "run-current-shadow",
      childSessionKey,
      task: "current shadow task",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
      endedAt: Date.now() - 2_000,
      pauseReason: "sessions_yield",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(),
      runs: [stale, currentShadowRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["current shadow task"],
    });
    expect(subagentRuns.get(currentShadowRun.runId)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal", endedAt: expect.any(Number) },
    });
    expect(subagentRuns.get(stale.runId)).toEqual(stale);
  });
});

describe("controlled subagent reads", () => {
  it.each([
    {
      name: "control owner",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:telegram:direct:abc123",
      expectedCount: 1,
    },
    {
      name: "completion owner",
      controllerSessionKey: "agent:main:telegram:direct:abc123",
      requesterSessionKey: "agent:main:main",
      expectedCount: 1,
    },
    {
      name: "unrelated session",
      controllerSessionKey: "agent:other:discord:direct:xyz",
      requesterSessionKey: "agent:other:main",
      expectedCount: 0,
    },
  ])(
    "applies read visibility for the $name",
    async ({ controllerSessionKey, requesterSessionKey, expectedCount }) => {
      const childSessionKey = "agent:main:subagent:list-visibility";
      await addRun({
        runId: "run-list-visibility",
        childSessionKey,
        controllerSessionKey,
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        task: "visibility test",
        createdAt: Date.now(),
        startedAt: Date.now(),
      });

      const { runs: results } = await buildControlledSubagentRunsReadContext("agent:main:main");
      expect(results).toHaveLength(expectedCount);
      if (expectedCount === 1) {
        expect(results[0]?.childSessionKey).toBe(childSessionKey);
      }
    },
  );

  it("uses one stable snapshot for listing and descendant counts", async () => {
    const now = Date.now();
    const rootSessionKey = "agent:main:main";
    const parentSessionKey = "agent:main:subagent:status-parent";
    await addRun({
      runId: "run-status-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: rootSessionKey,
      requesterSessionKey: rootSessionKey,
      requesterDisplayKey: rootSessionKey,
      task: "status parent",
      createdAt: now - 4_000,
      startedAt: now - 3_500,
      endedAt: now - 3_000,
    });
    await addRun({
      runId: "run-status-child-1",
      childSessionKey: `${parentSessionKey}:subagent:child-1`,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "status child 1",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const context = await buildControlledSubagentRunsReadContext(rootSessionKey);

    await addRun({
      runId: "run-status-child-2",
      childSessionKey: `${parentSessionKey}:subagent:child-2`,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "status child 2",
      createdAt: now - 1_000,
      startedAt: now - 500,
    });

    expect(context.runs.map((run) => run.runId)).toEqual(["run-status-parent"]);
    expect(context.list.pendingDescendants.get(parentSessionKey)).toBe(1);
    expect(
      (await buildControlledSubagentRunsReadContext(rootSessionKey)).list.pendingDescendants.get(
        parentSessionKey,
      ),
    ).toBe(2);
  });

  it("partitions duplicate bare controller keys by owning agent", async () => {
    const now = Date.now();
    for (const agentId of ["research", "ops"]) {
      await addRun({
        runId: `run-${agentId}`,
        childSessionKey: `agent:${agentId}:subagent:child`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
        task: `${agentId} task`,
        createdAt: now,
        startedAt: now,
      });
    }

    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { research: {}, ops: {} },
      },
    } as OpenClawConfig;
    const context = await buildControlledSubagentRunsReadContext("global", "research", cfg);
    expect(context.runs.map((run) => run.runId)).toEqual(["run-research"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
