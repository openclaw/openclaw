// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { mockSessionReplacementForStore } from "./subagent-control.leaf-mocks.test-support.js";
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture, useSubagentControlSessionStores } from "./subagent-control.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { stopSubagentsForRequester } from "../../../auto-reply/reply/abort-operation.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import * as controllerLifecycle from "../../../sessions/session-controller.lifecycle.js";
import {
  beginSessionEffect,
  consumeSessionEffectHandoff,
  getSessionMutationCount,
  isSessionMutationActive,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-controller.lifecycle.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { startControlProducer as startProducer } from "./subagent-control-native.test-support.js";
import * as killSession from "./subagent-control-session.js";
import { registerAdmissionDrainControlTests } from "./subagent-control.admission-drain.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { registerLateDescendantControlTests } from "./subagent-control.late-registration.test-support.js";
import { registerQueuedReservationFailureTests } from "./subagent-control.queued-failure.test-support.js";
import { registerControlledSubagentReadTests } from "./subagent-control.reads.test-support.js";
import {
  registerQueuedStopControlTests,
  registerRequestFrontierControlTests,
} from "./subagent-control.stop-selection.test-support.js";
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
  getSubagentRunByChildSessionKey as latestRun,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture({ reuseStateDir: true });
const { cfgWithSessionStore, writeSessionStoreFixture: writeSessionStore } =
  useSubagentControlSessionStores();

function withFixtureRevision<Entry extends { sessionId?: string; lifecycleRevision?: string }>(
  entry: Entry,
): Entry {
  return entry.sessionId && !Object.hasOwn(entry, "lifecycleRevision")
    ? { ...entry, lifecycleRevision: `${entry.sessionId}-revision` }
    : entry;
}

function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
  return writeSessionStore(
    label,
    Object.fromEntries(
      Object.entries(store).map(([key, entry]) => [
        key,
        entry &&
        typeof entry === "object" &&
        "sessionId" in entry &&
        typeof entry.sessionId === "string"
          ? withFixtureRevision({ ...entry, sessionId: entry.sessionId })
          : entry,
      ]),
    ),
  );
}

type ControlRuntime = typeof import("./subagent-control.runtime.js");

const controlRuntimeMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn<ControlRuntime["clearSessionQueues"]>(() => ({
    followupCleared: 0,
    keys: [],
  })),
}));

vi.mock("./subagent-control.runtime.js", () => controlRuntimeMocks);

function setSubagentControlDepsForTest(overrides: Partial<ControlRuntime> = {}) {
  controlRuntimeMocks.clearSessionQueues.mockReset();
  vi.mocked(applySessionEntryExactReplacements).mockReset();
  if (overrides.clearSessionQueues) {
    controlRuntimeMocks.clearSessionQueues.mockImplementation(overrides.clearSessionQueues);
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

function adminKill(
  sessionKey: string,
  storePath?: string,
  expected: Partial<Parameters<typeof killSubagentRunAdmin>[0]> = {},
) {
  return killSubagentRunAdmin({ cfg: cfgWithSessionStore(storePath), sessionKey, ...expected });
}

function controlledKill(
  runs: SubagentRunRecord[],
  storePath?: string,
  overrides: Partial<Parameters<typeof killAllControlledSubagentRuns>[0]> = {},
) {
  return killAllControlledSubagentRuns({
    cfg: cfgWithSessionStore(storePath),
    controller: controllerFor(),
    runs,
    ...overrides,
  });
}

function runOwner(
  controllerSessionKey: string,
  requesterSessionKey = controllerSessionKey,
  requesterDisplayKey = requesterSessionKey,
) {
  return { controllerSessionKey, requesterSessionKey, requesterDisplayKey };
}

const adminOwner = runOwner("agent:main:controller", "agent:main:requester", "requester");
const otherOwner = runOwner(
  "agent:main:other-controller",
  "agent:main:other-requester",
  "other-requester",
);

function resetRegistryLeafMocks() {
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
  vi.mocked(ensureContextEnginesInitialized).mockReset();
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
  fixture.worker.mockReset().mockImplementation(runSubagentStateWorkerOperation);
  vi.mocked(resolveContextEngine).mockReset();
}

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
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
    ...(overrides.childSessionIdentity
      ? { childSessionIdentity: withFixtureRevision(overrides.childSessionIdentity) }
      : {}),
  });
  return subagentRuns.get(overrides.runId)!;
}

function writeSession(label: string, sessionKey: string, entry: Partial<SessionEntry>) {
  return writeSessionStoreFixture(label, { [sessionKey]: entry });
}

function onPersistenceWrite(onWrite: () => void, phase: "before" | "after" = "before") {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          ...scope,
          execute: async (command, commandOptions) => {
            if (command.type === "subagents.persistChanges" && phase === "before") {
              onWrite();
            }
            const receipt = await scope.execute(command, commandOptions);
            if (command.type === "subagents.persistChanges" && phase === "after") {
              onWrite();
            }
            return receipt;
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

function runFixture(suffix: string, overrides: Partial<SubagentRunRecordOverrides> = {}) {
  return createSubagentRunRecord({
    runId: `run-${suffix}`,
    childSessionKey: `agent:main:subagent:${suffix}`,
    childSessionIdentity: { sessionId: `sess-${suffix}` },
    controllerSessionKey: "agent:main:main",
    createdAt: Date.now() - 5_000,
    startedAt: Date.now() - 4_000,
    ...overrides,
  });
}

async function storedRun(
  suffix: string,
  overrides: Partial<SubagentRunRecordOverrides> = {},
  session: Partial<SessionEntry> = {},
) {
  const input = runFixture(suffix, overrides);
  const storePath = await writeSession(suffix, input.childSessionKey, {
    ...input.childSessionIdentity,
    updatedAt: Date.now(),
    ...session,
  });
  const run = await addRun(input);
  return { run, storePath, childSessionKey: run.childSessionKey };
}

const controlTestDeps = {
  addRun,
  cfgWithSessionStore,
  controllerFor,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
  resetRegistryLeafMocks,
};

describe("killSubagentRunAdmin", () => {
  it.each(["verified", "legacy-unverified"] as const)(
    "does not mark a finalizing %s run killed when its abort is rejected",
    async (authority) => {
      const suffix = `worker-finalizing-${authority}`;
      const sessionId = `sess-${suffix}`;
      const {
        run: { runId },
        storePath,
        childSessionKey,
      } = await storedRun(
        suffix,
        {
          ...otherOwner,
          task: "finish the reply",
          ...(authority === "legacy-unverified" ? { childSessionIdentity: undefined } : {}),
        },
        { sessionId },
      );
      const { operation, cancel } = startProducer(
        childSessionKey,
        sessionId,
        storePath,
        undefined,
        runId,
      );
      operation.freezeAbort();
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
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.abortSignal.aborted).toBe(false);
      expect(operation.result).toBeNull();
      expect((await latestRun(childSessionKey))?.execution.endedAt).toBeUndefined();
      expect(
        loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun,
      ).toBeUndefined();
    },
  );

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await adminKill("agent:main:subagent:missing");

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
        childSessionIdentity: { sessionId: `${suffix}-session` },
        task: "replacement work",
        generation,
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 900,
      });
      for (const expected of constraints) {
        expect(await adminKill(childSessionKey, undefined, expected)).toEqual({
          found: false,
          killed: false,
        });
      }
      expect((await latestRun(childSessionKey))?.execution.endedAt).toBeUndefined();
    },
  );

  it("does not retarget a same-id recovery successor in the admin path", async () => {
    const childSessionKey = "agent:main:subagent:admin-same-id-successor";
    const runId = "run-admin-same-id";
    const source = await addRun({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-fenced-same-id-successor" },
      ...adminOwner,
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
    const cfg = cfgWithSessionStore();
    const { cancel: abort } = startProducer(
      childSessionKey,
      "sess-fenced-same-id-successor",
      cfg.session!.store!,
      undefined,
      runId,
    );

    const replacementReady = createDeferred();
    let replacementPending = true;
    const pendingKill = killSubagentRunAdmin(
      {
        cfg,
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
    const persistedChild = await latestRun(childSessionKey);
    expect(persistedChild).toMatchObject({
      runId,
      generation: 2,
      execution: { status: "running" },
    });
    expect(persistedChild?.execution.endedAt).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("keeps a killed steer-restart run on its failed projection", async () => {
    const childSessionKey = "agent:main:subagent:steer-restart";
    const endedAt = Date.now() - 1_000;
    await addRun({
      runId: "run-steer-restart",
      childSessionKey,
      childSessionIdentity: { sessionId: "steer-restart-session" },
      ...adminOwner,
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
      name: "reports when completion wins while Stop prepares cancellation",
      suffix: "completion-race",
      task: "finish while cancellation starts",
      completed: true,
    },
  ])("$name", async ({ suffix, task, completed }) => {
    const childSessionKey = `agent:main:subagent:${suffix}`;
    const current: SessionEntry = withFixtureRevision({
      sessionId: `sess-${suffix}`,
      updatedAt: Date.now(),
    });
    const storePath = await writeSession(`admin-kill-${suffix}`, childSessionKey, current);
    const input = runFixture(suffix, {
      childSessionIdentity: current,
      ...adminOwner,
      task,
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
    const publishTerminal = async () => {
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
      await terminalPublication;
    };
    const { cancel } = startProducer(childSessionKey, current.sessionId, storePath, async () => {
      if (!completed) {
        await publishTerminal();
      }
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

    const result = await killSubagentRunAdmin(
      {
        cfg: cfgWithSessionStore(storePath),
        sessionKey: childSessionKey,
      },
      completed
        ? {
            assertCurrent: () => {},
            beforeSessionKill: async () => {
              await publishTerminal();
              return true;
            },
          }
        : undefined,
    );
    await terminalPublication;
    expect(result).toMatchObject({ found: true, killed: !completed });
    expect(abortedLastRunWrites).toEqual(completed ? [] : [true]);
    if (completed) {
      expect(cancel).not.toHaveBeenCalled();
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
      childSessionIdentity: { sessionId: "sess-cascade-completion-race" },
      ...adminOwner,
      task: "finish while descendant cancellation settles",
    });
    const abortedLastRunWrites: boolean[] = [];
    await addRun({
      runId: "run-cascade-completion-child",
      childSessionKey: descendantSessionKey,
      childSessionIdentity: { sessionId: "sess-cascade-completion-child" },
      ...runOwner(childSessionKey, childSessionKey, "parent"),
      task: "descendant",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });
    let terminalPublication = Promise.resolve();
    startProducer(childSessionKey, "sess-cascade-completion-race", storePath);
    startProducer(descendantSessionKey, "sess-cascade-completion-child", storePath);
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

    const result = await adminKill(childSessionKey, storePath);

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

  it("kills a run that yields while Stop prepares cancellation", async () => {
    const { run, storePath, childSessionKey } = await storedRun("yield-race", {
      ...adminOwner,
      task: "yield while cancellation starts",
    });
    const yieldedAt = Date.now() - 1_000;
    let terminalPublication = Promise.resolve();
    startProducer(childSessionKey, "sess-yield-race", storePath);
    const publishYield = async () => {
      terminalPublication = publishRun(run.runId, (current) => ({
        ...current,
        execution: {
          ...current.execution,
          status: "terminal",
          endedAt: yieldedAt,
        },
        pauseReason: "sessions_yield",
      }));
      await terminalPublication;
    };

    const result = await killSubagentRunAdmin(
      {
        cfg: cfgWithSessionStore(storePath),
        sessionKey: childSessionKey,
      },
      {
        assertCurrent: () => {},
        beforeSessionKill: async () => {
          await publishYield();
          return true;
        },
      },
    );

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
    expect(await latestRun(childSessionKey)).toMatchObject({
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
    expect((await latestRun(childSessionKey))?.pauseReason).toBeUndefined();
    const killedAt =
      result.found && result.targetState?.state === "terminal"
        ? result.targetState.task.endedAt
        : undefined;
    expect(killedAt).toBeGreaterThan(yieldedAt);

    const repeated = await adminKill(childSessionKey, storePath);
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
      childSessionIdentity: { sessionId: "worker-stale-admin-session" },
      ...otherOwner,
      task: "stale admin task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    await addRun({
      runId: "run-current-admin",
      childSessionKey,
      childSessionIdentity: { sessionId: "worker-stale-admin-session" },
      ...otherOwner,
      task: "current admin task",
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await adminKill(childSessionKey);

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-current-admin",
      sessionKey: childSessionKey,
    });
    expect(result.found && result.targetState).toEqual({ state: "finalizing" });
  });

  it("does not retarget an ordinary same-id successor in the admin path", async () => {
    const childSessionKey = "agent:main:subagent:admin-same-id-successor";
    let source = createSubagentRunRecord({
      runId: "run-admin-same-id",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "admin source",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await addSubagentRunForTests(source);
    source = subagentRuns.get(source.runId)!;
    setSubagentControlDepsForTest({
      clearSessionQueues: () => ({ followupCleared: 0, keys: [] }),
    });

    const replacementReady = createDeferred();
    let replacementPending = true;
    const pendingKill = killSubagentRunAdmin(
      {
        cfg: cfgWithSessionStore(),
        sessionKey: childSessionKey,
      },
      {
        assertCurrent: () => {},
        prepareRead: () => (replacementPending ? replacementReady.promise : undefined),
      },
    );
    await addSubagentRunForTests({
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
      runId: source.runId,
    });
    expect(await latestRun(childSessionKey)).toMatchObject({
      runId: source.runId,
      generation: 2,
      execution: { status: "running" },
    });
  });

  it("does not mutate the run when the durable kill intent cannot persist", async () => {
    const childSessionKey = "agent:main:subagent:worker-store-fail";
    const storePath = await writeSessionStoreFixture("admin-kill-store-fail", {
      [childSessionKey]: {
        sessionId: "sess-worker-store-fail",
        updatedAt: Date.now(),
      },
    });

    await addSubagentRunForTests({
      runId: "run-worker-store-fail",
      childSessionKey,
      childSessionIdentity: {
        sessionId: "sess-worker-store-fail",
        lifecycleRevision: "sess-worker-store-fail-revision",
      },
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    resetRegistryLeafMocks();
    fixture.worker.mockImplementation((context, operation, options) =>
      runSubagentStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (command, commandOptions) => {
              if (command.type === "subagents.persistChanges") {
                throw new Error("session store unavailable");
              }
              return scope.execute(command, commandOptions);
            },
          }),
        options,
      ),
    );

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-worker-store-fail",
      sessionKey: childSessionKey,
      error: expect.stringContaining("Failed to persist subagent kill intent"),
    });
    expect(await latestRun(childSessionKey)).toMatchObject({
      runId: "run-worker-store-fail",
      execution: { status: "running" },
    });
    expect((await latestRun(childSessionKey))?.execution.endedAt).toBeUndefined();
  });
});

describe("controlled subagent cancellation races", () => {
  it("does not let 24 in-flight kills cross into same-id successor generations", async () => {
    const count = 24;
    const controllerSessionKey = "agent:main:main";
    const oldRuns = Array.from({ length: count }, (_, index) =>
      runFixture(`generation-race-${index}`, {
        runId: `run-old-${index}`,
        requesterSessionKey: controllerSessionKey,
        task: `old task ${index}`,
        generation: 1,
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

    const { clearSessionQueues: clearQueues } = controlRuntimeMocks;

    const replacementsReady = createDeferred();
    const killsEntered = oldRuns.map(() => createDeferred());
    const pendingKills = oldRuns.map((entry, index) =>
      controlledKill([entry], storePath, {
        controller: controllerFor(controllerSessionKey),
        beforeKill: async () => {
          killsEntered[index]!.resolve();
          await replacementsReady.promise;
          return true;
        },
      }),
    );

    await Promise.all(killsEntered.map((entered) => entered.promise));
    const successorProducers: ReturnType<typeof startProducer>[] = [];
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
        childSessionIdentity: { sessionId: `generation-leaf-${index}` },
        ...runOwner(entry.childSessionKey),
        task: `successor leaf ${index}`,
        generation: 1,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      successorProducers.push(
        startProducer(entry.childSessionKey, entry.childSessionIdentity!.sessionId, storePath),
        startProducer(descendantKeys[index]!, "generation-leaf-" + index, storePath),
      );
    }

    replacementsReady.resolve();
    const results = await Promise.all(pendingKills);

    expect(results.every((result) => result.status === "ok" && result.killed === 0)).toBe(true);
    expect(successorProducers.every(({ operation }) => !operation.abortSignal.aborted)).toBe(true);
    expect(clearQueues).not.toHaveBeenCalled();
    for (const [index, childSessionKey] of successorKeys.entries()) {
      const persistedChild = await latestRun(childSessionKey);
      expect(persistedChild).toMatchObject({
        runId: `run-old-${index}`,
        controllerSessionKey,
        generation: 2,
        execution: { status: "running" },
      });
      expect(persistedChild?.execution.endedAt).toBeUndefined();
      const persistedDescendant = await latestRun(descendantKeys[index]!);
      expect(persistedDescendant).toMatchObject({
        runId: `run-successor-leaf-${index}`,
        execution: { status: "running" },
      });
      expect(persistedDescendant?.execution.endedAt).toBeUndefined();
    }
  });

  it("fences a successor that appears while kill persistence is pending", async () => {
    const childSessionKey = "agent:main:subagent:persist-generation-race";
    const descendantSessionKey = `${childSessionKey}:subagent:leaf`;
    const controllerSessionKey = "agent:main:main";
    const oldRunFixture = runFixture("persist-generation-race", {
      runId: "run-persist-old",
      requesterSessionKey: controllerSessionKey,
      task: "old persisted task",
      generation: 1,
    });
    const storePath = await writeSession("persist-generation-race", childSessionKey, {
      sessionId: "sess-persist-generation-race",
      updatedAt: Date.now(),
    });
    const oldRun = await addRun(oldRunFixture);
    const { cancel } = startProducer(childSessionKey, "sess-persist-generation-race", storePath);

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

    const pendingKill = controlledKill([oldRun], storePath, {
      controller: controllerFor(controllerSessionKey),
    });
    try {
      await persistenceStarted.promise;

      await addRun({
        ...oldRunFixture,
        runId: "run-persist-successor",
        ...runOwner("agent:foreign:controller"),
        task: "successor persisted task",
        generation: 2,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      await addRun({
        ...oldRunFixture,
        runId: "run-persist-successor-leaf",
        childSessionKey: descendantSessionKey,
        childSessionIdentity: { sessionId: "persist-successor-leaf-session" },
        ...runOwner(childSessionKey),
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
    expect(cancel).toHaveBeenCalledOnce();
    expect(controlRuntimeMocks.clearSessionQueues).toHaveBeenCalledOnce();
    for (const [sessionKey, runId] of [
      [childSessionKey, "run-persist-successor"],
      [descendantSessionKey, "run-persist-successor-leaf"],
    ] as const) {
      const successor = await latestRun(sessionKey);
      expect(successor).toMatchObject({
        runId,
        execution: { status: "running" },
      });
      expect(successor?.execution.endedAt).toBeUndefined();
    }
  });

  it("does not abort or clear queues after the child session incarnation resets", async () => {
    const {
      run: entry,
      storePath,
      childSessionKey,
    } = await storedRun("kill-session-reset", {
      childSessionIdentity: {
        sessionId: "sess-kill-session-reset",
        lifecycleRevision: "revision-before-reset",
      },
      task: "old session work",
    });
    const { cancel: abort } = startProducer(childSessionKey, "sess-kill-session-reset", storePath);
    const clearQueues = controlRuntimeMocks.clearSessionQueues;
    onPersistenceWrite(() => {
      replaceSessionEntrySync(
        { storePath, sessionKey: childSessionKey },
        {
          sessionId: "sess-kill-session-reset",
          lifecycleRevision: "revision-after-reset",
          updatedAt: Date.now(),
        },
      );
    }, "after");

    await expect(controlledKill([entry], storePath)).resolves.toMatchObject({
      status: "error",
      error: "old session work: Subagent session changed while the kill was pending; retry.",
    });

    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    expect(await latestRun(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: undefined,
      execution: { status: "running" },
    });
  });

  it("does not patch the replacement session after the killed row commits", async () => {
    const {
      run: entry,
      storePath,
      childSessionKey,
    } = await storedRun("kill-session-patch-reset", {
      childSessionIdentity: {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-before-reset",
      },
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

    await expect(controlledKill([entry], storePath)).resolves.toMatchObject({
      status: "ok",
      killed: 1,
    });

    expect(patches).toEqual([null, null]);
    expect(await latestRun(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it.each([false, true])(
    "cascades only through the current child owner (moved: %s)",
    async (moved) => {
      const now = Date.now();
      const parent = await addRun(
        runFixture("old-parent", {
          createdAt: now - 8_000,
          startedAt: now - 7_000,
          endedAt: now - 6_000,
          outcome: { status: "ok" },
        }),
      );
      const newParent = runFixture("new-parent");
      if (moved) {
        await addRun(newParent);
      }
      const child = runFixture("child-stale", {
        childSessionKey: moved
          ? "agent:main:subagent:shared-child"
          : `${parent.childSessionKey}:subagent:child`,
        ...runOwner(parent.childSessionKey),
        createdAt: now - (moved ? 4_000 : 5_000),
        startedAt: now - (moved ? 3_500 : 4_000),
        ...(moved ? { endedAt: now - 3_000, outcome: { status: "ok" as const } } : {}),
      });
      await addRun(child);
      await addRun({
        ...child,
        runId: "run-child-current",
        ...runOwner(moved ? newParent.childSessionKey : parent.childSessionKey),
        createdAt: now - (moved ? 2_000 : 3_000),
        execution: moved
          ? { status: "running", startedAt: now - 1_500 }
          : {
              status: "terminal",
              startedAt: now - 2_000,
              endedAt: now - 1_500,
              outcome: { status: "ok" },
            },
      });
      const leaf = await addRun(
        runFixture("leaf-active", {
          childSessionKey: `${child.childSessionKey}:subagent:leaf`,
          ...runOwner(child.childSessionKey),
          task: "leaf task",
          createdAt: now - 1_000,
          startedAt: now - 900,
          ...(!moved ? { endedAt: now - 800, pauseReason: "sessions_yield" as const } : {}),
        }),
      );
      expect(await controlledKill([parent])).toEqual({
        status: "ok",
        killed: moved ? 0 : 1,
        labels: moved ? [] : ["leaf task"],
      });
      const currentLeaf = await latestRun(leaf.childSessionKey);
      expect(currentLeaf).toBeDefined();
      if (moved) {
        expect(currentLeaf?.execution.endedAt).toBeUndefined();
      } else {
        expect(currentLeaf?.execution.endedAt).toEqual(expect.any(Number));
      }
    },
  );

  it.each(["exact admin", "controlled"] as const)(
    "interrupts selected admission without retargeting an exact admin kill (%s)",
    async (mode) => {
      const exact = mode === "exact admin";
      const sessionId = "sess-recovery-admission";
      const entry = await addRun(
        runFixture("recovery-admission", {
          childSessionIdentity: { sessionId },
          createdAt: Date.now() - 2_000,
          ...(exact
            ? {
                ...adminOwner,
                completion: { required: false },
                delivery: { status: "pending" },
                generation: 1,
              }
            : { requesterSessionKey: "agent:main:main" }),
          execution: {
            status: exact ? "interrupted" : "running",
            startedAt: Date.now() - 1_000,
            ...(exact
              ? {
                  restartRecovery: {
                    sessionId,
                    sessionMarker: `${sessionId}:1`,
                    idempotencyKey: "recovery-successor",
                    phase: "accepted" as const,
                  },
                }
              : {}),
          },
        }),
      );
      const { childSessionKey } = entry;
      const storePath = await writeSession("recovery-admission", childSessionKey, {
        sessionId,
        updatedAt: Date.now(),
        abortedLastRun: true,
      });
      const interrupted = createDeferred();
      const admission = await beginSessionEffect({
        scope: storePath,
        identities: [childSessionKey, sessionId],
        run: { runId: entry.runId, sessionKey: childSessionKey, sessionId, agentId: "main" },
        assertAllowed: () => {},
        onInterrupt: () => {
          interrupted.resolve();
          return { runId: entry.runId };
        },
      });
      const handoffId = admission.createHandoff();
      const recoveryInterrupted = vi.fn();
      const abort = exact
        ? startProducer(childSessionKey, sessionId, storePath, undefined, "recovery-successor")
            .cancel
        : undefined;
      const pendingKill = exact
        ? adminKill(childSessionKey, storePath, { expectedRunId: entry.runId })
        : controlledKill([entry], storePath);
      let adopted: ReturnType<typeof consumeSessionEffectHandoff>;
      try {
        await interrupted.promise;
        expect(getSessionMutationCount()).toBeGreaterThan(0);
        adopted = consumeSessionEffectHandoff({
          handoffId,
          scope: storePath,
          identities: [childSessionKey, sessionId],
          onInterrupt: recoveryInterrupted,
        });
        expect(adopted).toBeDefined();
        if (exact) {
          expect(
            await replaceSubagentRunAfterSteerCore({
              previousRunId: entry.runId,
              nextRunId: "recovery-successor",
              expected: entry,
            }),
          ).toBe(true);
        } else {
          expect(recoveryInterrupted).toHaveBeenCalledOnce();
        }
        adopted?.release();
        if (exact) {
          await expect(pendingKill).resolves.toMatchObject({
            found: true,
            killed: false,
            runId: entry.runId,
          });
          const recoveredSuccessor = await latestRun(childSessionKey);
          expect(recoveredSuccessor).toMatchObject({
            runId: "recovery-successor",
            execution: { status: "running" },
          });
          expect(recoveredSuccessor?.execution.endedAt).toBeUndefined();
          expect(abort).not.toHaveBeenCalled();
        } else {
          await expect(pendingKill).resolves.toMatchObject({ status: "ok" });
          await expect(admission.released).resolves.toBeUndefined();
          expect(await latestRun(childSessionKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
      } finally {
        adopted?.release();
        admission.release();
        await pendingKill;
      }
    },
  );

  registerAdmissionDrainControlTests(controlTestDeps);

  it("leaves restart recovery disabled when the kill tombstone cannot persist", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-tombstone-failure";
    const sessionId = "sess-kill-tombstone-failure";
    const entry = await addRun({
      runId: "run-kill-tombstone-failure",
      childSessionKey,
      childSessionIdentity: { sessionId },
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
      controlledKill([entry], storePath, { controller: controllerFor(controllerSessionKey) }),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Failed to persist subagent kill tombstone"),
    });

    expect(abortedLastRunWrites).toEqual([]);
    expect(await latestRun(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: { reason: "killed", sessionId },
      execution: {
        status: "interrupted",
        restartRecovery: { phase: "reserved" },
      },
    });
    expect((await latestRun(childSessionKey))?.execution.endedAt).toBeUndefined();
  });

  it.for([
    { mode: "admin", blockedDepth: 0 },
    { mode: "controlled", blockedDepth: 1 },
  ] as const)(
    "cancels descendants while reporting pending ancestor cleanup ($mode)",
    async ({ mode, blockedDepth }, ctx) => {
      const runs: SubagentRunRecord[] = [];
      for (const role of ["root", "child", "leaf"]) {
        const parent = runs.at(-1);
        runs.push(
          await addRun(
            runFixture(`unsettled-${role}`, {
              ...runOwner(parent?.childSessionKey ?? "agent:main:main"),
              task: role,
            }),
          ),
        );
      }
      const storePath = await writeSessionStoreFixture(
        "kill-unsettled-tree",
        Object.fromEntries(
          runs.map((run) => [
            run.childSessionKey,
            { ...run.childSessionIdentity, updatedAt: Date.now() },
          ]),
        ),
      );
      const cleanup = createDeferred();
      const producers = runs.map((run, depth) =>
        startProducer(
          run.childSessionKey,
          run.childSessionIdentity!.sessionId,
          storePath,
          () => (depth === blockedDepth ? cleanup.promise : undefined),
          run.runId,
        ),
      );
      const blockedRun = runs[blockedDepth]!;
      const blockedProducer = producers[blockedDepth]!;
      const mutationReleased = createDeferred();
      const mutate = controllerLifecycle.runSessionMutation;
      using mutationObserver = vi.spyOn(controllerLifecycle, "runSessionMutation");
      mutationObserver.mockImplementation((params) => {
        const mutation = mutate(params);
        if (
          "scope" in params &&
          params.scope === storePath &&
          [...params.identities].includes(blockedRun.childSessionKey)
        ) {
          void mutation.then(
            () => mutationReleased.resolve(),
            (error: unknown) => mutationReleased.reject(error),
          );
        }
        return mutation;
      });
      let producerSettled = false;
      void blockedProducer.operation.ownerSettlement.then(() => {
        producerSettled = true;
      });
      vi.useFakeTimers();
      const pendingKill =
        mode === "admin"
          ? adminKill(runs[0]!.childSessionKey, storePath)
          : controlledKill([runs[0]!], storePath);
      try {
        // The deadline starts after durable kill publication releases its mutation.
        await withinTest(
          awaitGateBeforeSettlement(
            mutationReleased.promise,
            pendingKill,
            "Stop returned before releasing its selected mutation",
          ),
          ctx.signal,
        );
        expect(blockedProducer.operation.abortSignal.aborted).toBe(true);
        expect(
          isSessionMutationActive(storePath, [
            blockedRun.childSessionKey,
            blockedRun.childSessionIdentity!.sessionId,
          ]),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);

        const result = await withinTest<Awaited<typeof pendingKill>>(pendingKill, ctx.signal);
        expect(result).toMatchObject({
          error: expect.stringContaining(
            "Subagent execution settlement failed: Subagent execution cleanup remains pending after its drain deadline.",
          ),
          ...(mode === "admin"
            ? { found: true, killed: true, cascadeKilled: 2, cascadeLabels: ["child", "leaf"] }
            : { status: "error", killed: 3, failed: 1, labels: ["root", "child", "leaf"] }),
        });
        expect(producerSettled).toBe(false);
        for (const [index, run] of runs.entries()) {
          expect(producers[index]!.cancel).toHaveBeenCalledOnce();
          expect(producers[index]!.operation.abortSignal.aborted).toBe(true);
          expect(await latestRun(run.childSessionKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
      } finally {
        cleanup.resolve();
        vi.useRealTimers();
        await pendingKill;
        await blockedProducer.operation.ownerSettlement;
      }
    },
  );
});

describe("killAllControlledSubagentRuns", () => {
  registerLateDescendantControlTests(controlTestDeps);

  registerQueuedStopControlTests(controlTestDeps);

  registerQueuedReservationFailureTests(controlTestDeps);

  registerRequestFrontierControlTests(fixture);

  it.each([false, true])(
    "preserves exactRunId=%s authority when an in-flight launch remaps the same row",
    async (exactRunId) => {
      const runId = "launch-before-admission";
      const childSessionKey = "agent:main:subagent:launch-remap";
      const sessionId = "launch-remap-session";
      const controllerSessionKey = "agent:main:main";
      const entry = await addRun({
        runId,
        childSessionKey,
        childSessionIdentity: { sessionId },
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "launch remap",
        createdAt: 1,
        collect: true,
        swarmLaunchPending: true,
        schedulerSlotId: runId,
        execution: { status: "queued" },
      });
      const storePath = await writeSession("launch-remap", childSessionKey, {
        sessionId,
        updatedAt: 1,
      });
      const admission = await beginSessionEffect({
        scope: storePath,
        identities: [childSessionKey, sessionId],
        run: { runId, sessionKey: childSessionKey, sessionId, agentId: "main" },
        assertAllowed: () => {},
      });
      const response = createDeferred();
      const started = createDeferred();
      const launchDone = createDeferred();
      const lease = consumeSessionEffectHandoff({
        handoffId: admission.createHandoff(),
        scope: storePath,
        identities: [childSessionKey, sessionId],
        onInterrupt: () => {
          response.resolve();
          return { runId };
        },
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
      try {
        await started.promise;
        const cfg = cfgWithSessionStore(storePath);
        if (exactRunId) {
          expect(
            await killSubagentRunAdmin({ cfg, sessionKey: childSessionKey, expectedRunId: runId }),
          ).toMatchObject({ killed: true });
        } else {
          expect(
            await killAllControlledSubagentRuns({
              cfg,
              controller: controllerFor(controllerSessionKey),
              runs: [entry],
            }),
          ).toMatchObject({ killed: 1 });
        }
        expect((await latestRun(childSessionKey))?.runId).toBe("accepted-launch");
      } finally {
        response.resolve();
        await launchDone.promise;
        lease?.release();
        swarmSchedulerTesting.reset();
      }
    },
  );

  it("checks controller agent identity before holding or cancelling bare-session children", async () => {
    const entries = ["main", "work"].map((requesterAgentId) =>
      createSubagentRunRecord({
        runId: `agent-owned-${requesterAgentId}`,
        childSessionKey: `agent:${requesterAgentId}:subagent:worker`,
        childSessionIdentity: { sessionId: `${requesterAgentId}-worker-session` },
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
      childSessionIdentity: { sessionId: "bulk-persistence-first-session" },
      controllerSessionKey: "agent:main:main",
      task: "first bulk task",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_900,
    });
    const secondFixture = createSubagentRunRecord({
      ...firstFixture,
      runId: "run-bulk-persistence-failure-second",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-second",
      childSessionIdentity: { sessionId: "bulk-persistence-second-session" },
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
    expect((await latestRun(first.childSessionKey))?.execution.endedAt).toBeUndefined();
    expect((await latestRun(second.childSessionKey))?.execution.endedAt).toBeTypeOf("number");
  });

  it("does not let a stale bulk entry suppress the current yielded entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = await writeSession("stale-kill-all-shadow", childSessionKey, {
      sessionId: "shadow-session",
      updatedAt: Date.now(),
    });

    await addRun({
      runId: "run-stale-shadow",
      childSessionKey,
      childSessionIdentity: { sessionId: "shadow-session" },
      task: "stale shadow task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    const stale = subagentRuns.get("run-stale-shadow")!;
    const currentShadowRun = await addRun({
      runId: "run-current-shadow",
      childSessionKey,
      childSessionIdentity: { sessionId: "shadow-session" },
      task: "current shadow task",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
      endedAt: Date.now() - 2_000,
      pauseReason: "sessions_yield",
    });

    const result = await controlledKill([stale, currentShadowRun], storePath);

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

registerControlledSubagentReadTests(addRun);
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
