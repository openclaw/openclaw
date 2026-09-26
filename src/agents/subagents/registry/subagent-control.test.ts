// Subagent control tests cover listing, killing, and admin cleanup of
// child runs recorded in the subagent registry and session store.
import "./subagent-control.leaf-mocks.test-support.js";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { stopSubagentsForRequester } from "../../../auto-reply/reply/abort-operation.js";
import { tryFastAbortFromMessage } from "../../../auto-reply/reply/abort.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getActiveSessionLifecycleMutationCount,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  enqueueSwarmRun,
  releaseSwarmRun,
  removeQueuedSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  buildControlledSubagentRunsReadContext,
  killAllControlledSubagentRuns,
  killSubagentRunAdmin,
} from "./subagent-control.js";
import { registerLateDescendantControlTests } from "./subagent-control.late-registration.test-support.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import * as registryState from "./subagent-registry-state.js";
import {
  replaceSubagentRunAfterSteerCore,
  markSubagentRunTerminated,
  startQueuedSubagentRun,
} from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

type ControlRuntime = typeof import("./subagent-control.runtime.js");

const controlRuntimeMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<ControlRuntime["abortEmbeddedAgentRun"]>(() => false),
  isEmbeddedAgentRunActive: vi.fn<ControlRuntime["isEmbeddedAgentRunActive"]>(() => false),
  clearSessionQueues: vi.fn<ControlRuntime["clearSessionQueues"]>(() => ({
    followupCleared: 0,
    laneCleared: 0,
    keys: [],
  })),
}));

vi.mock("./subagent-control.runtime.js", () => controlRuntimeMocks);

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return { ...actual, patchSessionEntryCore: vi.fn(actual.patchSessionEntryCore) };
});

const { patchSessionEntryCore: patchCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-accessor.js")
>("../../../config/sessions/session-accessor.js");

vi.mock("../../../gateway/call.js", () => ({
  // Active fixture runs stay pending until the test drives their terminal transition.
  callGateway: vi.fn(async (request: { method: string }) =>
    request.method === "agent.wait" ? { status: "pending" } : {},
  ),
}));

const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  findDetachedTaskRun: vi.fn(() => ({ lookup: "available" as const })),
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => []),
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  createQueuedTaskRun: vi.fn(() => null),
  createRunningTaskRun: vi.fn(() => null),
  startTaskRunByRunId: vi.fn(() => []),
  recordTaskRunProgressByRunId: vi.fn(() => []),
  finalizeTaskRunByRunId: detachedTaskRuntimeMocks.finalizeTaskRunByRunId,
  completeTaskRunByRunId: vi.fn(() => []),
  failTaskRunByRunId: vi.fn(() => []),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
  findDetachedTaskRun: detachedTaskRuntimeMocks.findDetachedTaskRun,
}));

function setSubagentControlDepsForTest(overrides: Partial<ControlRuntime> = {}) {
  controlRuntimeMocks.abortEmbeddedAgentRun.mockReset();
  controlRuntimeMocks.isEmbeddedAgentRunActive.mockReset();
  controlRuntimeMocks.clearSessionQueues.mockReset();
  // Default to the canonical store; individual race tests replace only their fault boundary.
  vi.mocked(patchSessionEntryCore).mockReset();
  if (overrides.abortEmbeddedAgentRun) {
    controlRuntimeMocks.abortEmbeddedAgentRun.mockImplementation(overrides.abortEmbeddedAgentRun);
  }
  if (overrides.isEmbeddedAgentRunActive) {
    controlRuntimeMocks.isEmbeddedAgentRunActive.mockImplementation(
      overrides.isEmbeddedAgentRunActive,
    );
  }
  if (overrides.clearSessionQueues) {
    controlRuntimeMocks.clearSessionQueues.mockImplementation(overrides.clearSessionQueues);
  }
}

function mockSessionPatchForStore(storePath: string, implementation: typeof patchSessionEntryCore) {
  // Registry timing writes use a different store; a fault must not fabricate entries there.
  vi.mocked(patchSessionEntryCore).mockImplementation((scope, patcher, options) =>
    scope.storePath === storePath
      ? implementation(scope, patcher, options)
      : patchCanonicalSessionEntry(scope, patcher, options),
  );
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(tempRoot);
    cleanup();
  }),
);
const tempRoot = tempDirs.make("openclaw-subagent-control-");
let tempStoreIndex = 0;

function nextSessionStorePath(label: string) {
  tempStoreIndex += 1;
  return path.join(tempRoot, `${tempStoreIndex}-${label}.json`);
}

function cfgWithSessionStore(storePath = nextSessionStorePath("sessions")): OpenClawConfig {
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

function controllerFor(controllerSessionKey = "agent:main:main") {
  return {
    controllerSessionKey,
    callerSessionKey: controllerSessionKey,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
}

async function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
  const storePath = nextSessionStorePath(label);
  for (const [sessionKey, entry] of Object.entries(store)) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId
        : `sess-${sessionKey.replaceAll(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
    await replaceSessionEntry({ storePath, sessionKey }, {
      ...record,
      sessionId,
    } as SessionEntry);
  }
  return storePath;
}

function resetRegistryLeafMocks() {
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
  vi.mocked(ensureContextEnginesInitialized).mockReset();
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
  vi.mocked(registryState.persistSubagentRunsToDisk).mockReset();
  vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockReset();
  vi.mocked(registryState.restoreSubagentRunsFromDisk).mockReset();
  vi.mocked(resolveContextEngine).mockReset();
}

beforeEach(() => {
  detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mockClear();
  setSubagentControlDepsForTest();
  resetRegistryLeafMocks();
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockResolvedValue(undefined);
  vi.mocked(ensureContextEnginesInitialized).mockImplementation(() => {});
  vi.mocked(registryState.persistSubagentRunsToDisk).mockImplementation(() => {});
  vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(() => {});
  vi.mocked(registryState.restoreSubagentRunsFromDisk).mockReturnValue(0);
  vi.mocked(resolveContextEngine).mockImplementation(async () => ({
    info: { id: "test", name: "Test" },
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    ingest: async () => ({ ingested: false }),
  }));
});

afterEach(resetRegistryLeafMocks);

describe("killSubagentRunAdmin", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("kills a subagent by session key without requester ownership checks", async () => {
    const childSessionKey = "agent:main:subagent:worker";
    const storePath = await writeSessionStoreFixture("admin-kill", {
      [childSessionKey]: {
        sessionId: "sess-worker",
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const cfg = cfgWithSessionStore(storePath);

    const result = await killSubagentRunAdmin({
      cfg,
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(true);
    if (!result.found) {
      throw new Error("expected tracked subagent run");
    }
    expect(result.runId).toBe("run-worker");
    expect(result.sessionKey).toBe(childSessionKey);
    expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun).toBe(true);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-worker",
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
      }),
    );
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it("does not kill a replacement run when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:replacement";
    addSubagentRunForTests({
      runId: "run-current",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "replacement work",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-stale",
    });

    expect(result).toEqual({ found: false, killed: false });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });

  it("does not kill a same-id replacement generation", async () => {
    const childSessionKey = "agent:main:subagent:same-id-replacement";
    addSubagentRunForTests({
      runId: "run-reused",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "replacement work",
      generation: 2,
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-reused",
      expectedGeneration: 1,
      expectedOwnerKey: "agent:main:main",
    });
    const foreignOwner = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-reused",
      expectedGeneration: 2,
      expectedOwnerKey: "agent:main:other",
    });

    expect(result).toEqual({ found: false, killed: false });
    expect(foreignOwner).toEqual({ found: false, killed: false });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });

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
    const source = createSubagentRunRecord({
      runId: "run-fenced-recovery-source",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "source recovery task",
      generation: 1,
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: receipt,
      },
    });
    addSubagentRunForTests(source);
    const storePath = await writeSessionStoreFixture("fenced-recovery-successor", {
      [childSessionKey]: { sessionId, updatedAt: Date.now(), abortedLastRun: true },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    const abort = vi.fn(() => true);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
      expectedRunId: source.runId,
    });
    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
    const adopted = consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: storePath,
      identities: [childSessionKey, sessionId],
      onInterrupt: () => undefined,
    });
    expect(
      replaceSubagentRunAfterSteerCore({
        previousRunId: source.runId,
        nextRunId: recoveryRunId,
        expected: source,
        persistenceFailure: "return-false",
      }),
    ).toBe(true);
    expect(adopted).toBeDefined();
    adopted?.release();

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId: source.runId,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: recoveryRunId,
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("does not adopt a same-id successor when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:fenced-same-id-successor";
    const runId = "run-fenced-same-id-successor";
    const source = createSubagentRunRecord({
      runId,
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "same-id recovery source",
      generation: 1,
      createdAt: Date.now() - 2_000,
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
    addSubagentRunForTests(source);
    const abort = vi.fn(() => false);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: runId,
    });
    addSubagentRunForTests({
      ...source,
      task: "same-id recovery successor",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId,
      generation: 2,
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("keeps a killed steer-restart run on its failed projection", async () => {
    const childSessionKey = "agent:main:subagent:steer-restart";
    const endedAt = Date.now() - 1_000;
    addSubagentRunForTests({
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
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("restores the recoverable task marker when abort lifecycle wins the race", async () => {
    const childSessionKey = "agent:main:subagent:abort-lifecycle-race";
    const storePath = await writeSessionStoreFixture("admin-kill-abort-lifecycle-race", {
      [childSessionKey]: {
        sessionId: "sess-abort-lifecycle-race",
        updatedAt: Date.now(),
      },
    });
    const run = createSubagentRunRecord({
      runId: "run-abort-lifecycle-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while aborting",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          suppressAnnounceReason: "killed" as const,
          killReconciliation: { killedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "error" as const, error: "agent run aborted" },
        });
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId: "sess-abort-lifecycle-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      abortedLastRunWrites.push(patch?.abortedLastRun === true);
      return patch ? { ...current, ...patch } : current;
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({ found: true, killed: true });
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-abort-lifecycle-race",
        status: "cancelled",
        error: SUBAGENT_KILL_TASK_ERROR,
      }),
    );
    expect(abortedLastRunWrites).toEqual([]);
  });

  it("reports when completion wins while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:completion-race";
    const storePath = await writeSessionStoreFixture("admin-kill-completion-race", {
      [childSessionKey]: {
        sessionId: "sess-completion-race",
        updatedAt: Date.now(),
      },
    });
    const run = createSubagentRunRecord({
      runId: "run-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while cancellation starts",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests({
      ...run,
      runId: "run-stale-completion-race",
      task: "stale older row",
      createdAt: Date.now() - 9_000,
      execution: { status: "running", startedAt: Date.now() - 8_000 },
    });
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          completion: { required: false, resultText: "done", capturedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "ok" as const },
        });
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId: "sess-completion-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      abortedLastRunWrites.push(patch?.abortedLastRun === true);
      return patch ? { ...current, ...patch } : current;
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: {
          status: "succeeded",
          endedAt: expect.any(Number),
          progressSummary: "done",
          terminalSummary: null,
        },
      },
      runId: "run-completion-race",
    });
    expect(abortedLastRunWrites).toEqual([]);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { outcome: { status: "ok" } },
    });
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
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
    const run = createSubagentRunRecord({
      runId: "run-cascade-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while descendant cancellation settles",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests(run);
    addSubagentRunForTests({
      runId: "run-cascade-completion-child",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: "parent",
      task: "descendant",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
    });
    mockSessionPatchForStore(storePath, async (scope, patcher) => {
      if (!scope.storePath) {
        return null;
      }
      const current = loadSessionEntry({
        storePath: scope.storePath,
        sessionKey: scope.sessionKey,
        clone: false,
      });
      if (!current) {
        return null;
      }
      const patch = await patcher(current, { existingEntry: { ...current } });
      if (scope.sessionKey === childSessionKey) {
        abortedLastRunWrites.push(patch?.abortedLastRun === true);
      }
      if (scope.sessionKey === descendantSessionKey) {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          completion: { required: false, resultText: "done", capturedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "ok" as const },
        });
      }
      return patch ? { ...current, ...patch } : current;
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      targetState: {
        state: "terminal",
        task: {
          status: "succeeded",
          progressSummary: "done",
        },
      },
    });
    expect(abortedLastRunWrites).toEqual([true, false]);
  });

  it("kills a run that yields while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:yield-race";
    const storePath = await writeSessionStoreFixture("admin-kill-yield-race", {
      [childSessionKey]: {
        sessionId: "sess-yield-race",
        updatedAt: Date.now(),
      },
    });
    const run = createSubagentRunRecord({
      runId: "run-yield-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "yield while cancellation starts",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const yieldedAt = Date.now() - 1_000;
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        Object.assign(run.execution, { status: "terminal" as const, endedAt: yieldedAt });
        run.pauseReason = "sessions_yield";
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async () => null);

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-yield-race",
      targetState: {
        state: "terminal",
        task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
      },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
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
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.pauseReason).toBeUndefined();
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-yield-race", status: "cancelled" }),
    );
    const [finalizeArgs] = detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mock.calls[0] ?? [];
    const killedAt = (finalizeArgs as { endedAt?: number } | undefined)?.endedAt;
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
    const [repeatedFinalizeArgs] =
      detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mock.calls.at(-1) ?? [];
    expect((repeatedFinalizeArgs as { endedAt?: number } | undefined)?.endedAt).toBe(killedAt);
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
  });

  it("does not mark a finalizing run killed when its abort is rejected", async () => {
    const childSessionKey = "agent:main:subagent:worker-finalizing";
    const storePath = await writeSessionStoreFixture("admin-kill-finalizing", {
      [childSessionKey]: {
        sessionId: "sess-worker-finalizing",
        updatedAt: Date.now(),
      },
    });
    await replaceSessionEntry(
      { sessionKey: childSessionKey, storePath },
      {
        sessionId: "sess-worker-finalizing",
        updatedAt: Date.now(),
      },
    );

    addSubagentRunForTests({
      runId: "run-worker-finalizing",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "finish the reply",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => false,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(false);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
  });

  it("does not kill a newest finalizing run when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:worker-stale-admin";

    addSubagentRunForTests({
      runId: "run-stale-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "stale admin task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "current admin task",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(false);
    if (!result.found) {
      throw new Error("expected finalizing subagent run");
    }
    if (!("targetState" in result)) {
      throw new Error("expected finalizing target state");
    }
    expect(result.targetState).toEqual({ state: "finalizing" });
    expect(result.runId).toBe("run-current-admin");
    expect(result.sessionKey).toBe(childSessionKey);
  });

  it("does not retarget an ordinary same-id successor in the admin path", async () => {
    const childSessionKey = "agent:main:subagent:admin-same-id-successor";
    const source = createSubagentRunRecord({
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
    addSubagentRunForTests(source);
    const abort = vi.fn(() => false);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
    });
    addSubagentRunForTests({
      ...source,
      task: "admin successor",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId: source.runId,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
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

    addSubagentRunForTests({
      runId: "run-worker-store-fail",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    resetRegistryLeafMocks();
    vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(() => {
      throw new Error("session store unavailable");
    });

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
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-worker-store-fail",
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });
});

describe("controlled subagent cancellation races", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("does not mutate the live session when the caller passes a stale run entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-worker";
    const storePath = await writeSessionStoreFixture("stale-kill", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-current",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current task",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(),
      runs: [
        createSubagentRunRecord({
          runId: "run-stale",
          childSessionKey,
          controllerSessionKey: "agent:main:main",
          task: "stale task",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        }),
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current");
  });

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
    for (const entry of oldRuns) {
      addSubagentRunForTests(entry);
    }

    const isActive = vi.fn(() => false);
    const abort = vi.fn(() => false);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: isActive,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: clearQueues,
    });

    const pendingKills = oldRuns.map((entry) =>
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(controllerSessionKey),
        runs: [entry],
      }),
    );

    const successorKeys: string[] = [];
    const descendantKeys: string[] = [];
    for (const [index, entry] of oldRuns.entries()) {
      successorKeys.push(entry.childSessionKey);
      descendantKeys.push(`${entry.childSessionKey}:subagent:leaf`);
      addSubagentRunForTests({
        ...entry,
        runId: entry.runId,
        task: `successor task ${index}`,
        generation: 2,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      addSubagentRunForTests({
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

    const results = await Promise.all(pendingKills);

    expect(results.every((result) => result.status === "ok" && result.killed === 0)).toBe(true);
    expect(isActive).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    for (const [index, childSessionKey] of successorKeys.entries()) {
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: `run-old-${index}`,
        controllerSessionKey,
        generation: 2,
        execution: { status: "running" },
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
      expect(getSubagentRunByChildSessionKey(descendantKeys[index]!)).toMatchObject({
        runId: `run-successor-leaf-${index}`,
        execution: { status: "running" },
      });
      expect(
        getSubagentRunByChildSessionKey(descendantKeys[index]!)?.execution.endedAt,
      ).toBeUndefined();
    }
  });

  it("fences a successor that appears while kill persistence is pending", async () => {
    const childSessionKey = "agent:main:subagent:persist-generation-race";
    const descendantSessionKey = `${childSessionKey}:subagent:leaf`;
    const controllerSessionKey = "agent:main:main";
    const oldRun = createSubagentRunRecord({
      runId: "run-persist-old",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "old persisted task",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const storePath = await writeSessionStoreFixture("persist-generation-race", {
      [childSessionKey]: {
        sessionId: "sess-persist-generation-race",
        updatedAt: Date.now(),
      },
    });
    addSubagentRunForTests(oldRun);

    let releasePersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceRelease = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const abort = vi.fn(() => false);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: clearQueues,
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      markPersistenceStarted();
      await persistenceRelease;
      const current = { sessionId: "sess-persist-generation-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      return patch ? { ...current, ...patch } : current;
    });

    const pendingKill = killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(controllerSessionKey),
      runs: [oldRun],
    });
    await persistenceStarted;

    addSubagentRunForTests({
      ...oldRun,
      runId: "run-persist-successor",
      controllerSessionKey: "agent:foreign:controller",
      requesterSessionKey: "agent:foreign:controller",
      requesterDisplayKey: "agent:foreign:controller",
      task: "successor persisted task",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });
    addSubagentRunForTests({
      ...oldRun,
      runId: "run-persist-successor-leaf",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "successor persisted leaf",
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });
    releasePersistence();

    await expect(pendingKill).resolves.toMatchObject({
      status: "ok",
      killed: 1,
      labels: ["old persisted task"],
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(clearQueues).toHaveBeenCalledOnce();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-persist-successor",
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(descendantSessionKey)).toMatchObject({
      runId: "run-persist-successor-leaf",
      execution: { status: "running" },
    });
    expect(
      getSubagentRunByChildSessionKey(descendantSessionKey)?.execution.endedAt,
    ).toBeUndefined();
  });

  it("does not abort or clear queues after the child session incarnation resets", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-reset";
    const storePath = await writeSessionStoreFixture("kill-session-reset", {
      [childSessionKey]: {
        sessionId: "sess-kill-session-reset",
        lifecycleRevision: "revision-before-reset",
        updatedAt: Date.now(),
      },
    });
    const entry = createSubagentRunRecord({
      runId: "run-kill-session-reset",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "old session work",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(entry);
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
      clearSessionQueues: clearQueues,
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
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: undefined,
      execution: { status: "running" },
    });
  });

  it("does not patch the replacement session after the killed row commits", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-patch-reset";
    const storePath = await writeSessionStoreFixture("kill-session-patch-reset", {
      [childSessionKey]: {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-before-reset",
        updatedAt: Date.now(),
      },
    });
    const entry = createSubagentRunRecord({
      runId: "run-kill-session-patch-reset",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "do not patch successor",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(entry);
    const patches: Array<Partial<SessionEntry> | null> = [];
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const replacement: SessionEntry = {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-after-reset",
        updatedAt: Date.now(),
      };
      const patch = await patcher(replacement, { existingEntry: { ...replacement } });
      patches.push(patch);
      return patch ? { ...replacement, ...patch } : replacement;
    });

    await expect(
      killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(),
        runs: [entry],
      }),
    ).resolves.toMatchObject({ status: "ok", killed: 1 });

    expect(patches).toEqual([null]);
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it("kills a yielded descendant without reviving a stale child row", async () => {
    const parentSessionKey = "agent:main:subagent:kill-parent";
    const childSessionKey = `${parentSessionKey}:subagent:child`;
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const parentRun = createSubagentRunRecord({
      runId: "run-parent-current",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current parent task",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests(parentRun);
    addSubagentRunForTests({
      runId: "run-child-stale",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "stale child task",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests({
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
    addSubagentRunForTests({
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
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.execution.endedAt).toBeTypeOf("number");
  });

  it("does not cascade through a child session that moved to a newer parent", async () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const oldParentRun = createSubagentRunRecord({
      runId: "run-old-parent-current",
      childSessionKey: oldParentSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "old parent task",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests(oldParentRun);
    addSubagentRunForTests({
      runId: "run-new-parent-current",
      childSessionKey: newParentSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "new parent task",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests({
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
    addSubagentRunForTests({
      runId: "run-child-current-new-parent",
      childSessionKey,
      controllerSessionKey: newParentSessionKey,
      requesterSessionKey: newParentSessionKey,
      requesterDisplayKey: newParentSessionKey,
      task: "current shared child task",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_500,
    });
    addSubagentRunForTests({
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
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.execution.endedAt).toBeUndefined();
  });

  it("interrupts a pending recovery admission before deciding the kill target is inactive", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-recovery-admission";
    const sessionId = "sess-kill-recovery-admission";
    const entry = createSubagentRunRecord({
      runId: "run-kill-recovery-admission",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "kill recovery admission",
      createdAt: Date.now() - 2_000,
      execution: { status: "running", startedAt: Date.now() - 1_000 },
    });
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("kill-recovery-admission", {
      [childSessionKey]: { sessionId, updatedAt: Date.now(), abortedLastRun: true },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    let recoveryActive = false;
    const abort = vi.fn(() => recoveryActive);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => recoveryActive,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(controllerSessionKey),
      runs: [entry],
    });
    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
    const adopted = consumeSessionWorkAdmissionHandoff({
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
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it.each([false, true])(
    "releases queued=%s work when interrupted admission does not drain",
    async (queued) => {
      const controllerSessionKey = "agent:main:main";
      const childSessionKey = "agent:main:subagent:kill-admission-timeout";
      const sessionId = "sess-kill-admission-timeout";
      const entry = createSubagentRunRecord({
        runId: "run-kill-admission-timeout",
        childSessionKey,
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "hold admission during kill",
        createdAt: Date.now() - 2_000,
        collect: queued,
        execution: queued
          ? { status: "queued" }
          : { status: "running", startedAt: Date.now() - 1_000 },
      });
      addSubagentRunForTests(entry);
      const storePath = await writeSessionStoreFixture("kill-admission-timeout", {
        [childSessionKey]: { sessionId, updatedAt: Date.now() },
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [childSessionKey, sessionId],
        assertAllowed: () => {},
      });
      setSubagentControlDepsForTest({
        isEmbeddedAgentRunActive: () => false,
        abortEmbeddedAgentRun: () => false,
        clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
      });

      const dispatch = vi.fn(async () => {});
      if (queued) {
        enqueueSwarmRun({
          groupId: "drain",
          runId: entry.runId,
          maxConcurrent: 1,
          activeRunIds: ["holder"],
          start: dispatch,
          onStartFailure: () => true,
        });
      }
      vi.useFakeTimers();
      try {
        const pendingKill = killAllControlledSubagentRuns({
          cfg: cfgWithSessionStore(storePath),
          controller: controllerFor(controllerSessionKey),
          runs: [entry],
        });
        await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
        if (queued) {
          releaseSwarmRun("holder");
        }
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);

        await expect(pendingKill).resolves.toMatchObject({
          status: "error",
          error:
            "hold admission during kill: Subagent is still active; try the kill again in a moment.",
        });
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.killIntent).toBeUndefined();
        if (queued) {
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        }
      } finally {
        admission.release();
        swarmSchedulerTesting.reset();
        vi.useRealTimers();
      }
    },
  );

  it("leaves restart recovery disabled when the kill tombstone cannot persist", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-tombstone-failure";
    const sessionId = "sess-kill-tombstone-failure";
    const entry = createSubagentRunRecord({
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
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("kill-tombstone-failure", {
      [childSessionKey]: { sessionId, updatedAt: 1, abortedLastRun: true },
    });
    const abortedLastRunWrites: boolean[] = [];
    let persistenceWrites = 0;
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId, updatedAt: 1, abortedLastRun: true };
      const patch = await patcher(current, { existingEntry: { ...current } });
      if (patch) {
        abortedLastRunWrites.push(patch.abortedLastRun === true);
      }
      return patch ? { ...current, ...patch } : current;
    });
    resetRegistryLeafMocks();
    vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(() => {
      persistenceWrites += 1;
      if (persistenceWrites === 2) {
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
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: { reason: "killed", sessionId },
      execution: {
        status: "interrupted",
        restartRecovery: { phase: "reserved" },
      },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });
});

describe("killAllControlledSubagentRuns", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  registerLateDescendantControlTests({
    cfgWithSessionStore,
    setSubagentControlDepsForTest,
    writeSessionStoreFixture,
  });

  it.each(["bulk", "first cancellation await", "controlled tree", "admin tree", "channel stop"])(
    "does not dispatch selected queued work during %s cancellation",
    async (kind) => {
      const controllerSessionKey = "agent:main:main";
      const running = createSubagentRunRecord({
        runId: "running-collector",
        childSessionKey: "agent:main:subagent:running-collector",
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "running collector",
        collect: true,
        createdAt: 1,
        startedAt: 2,
      });
      const queued = createSubagentRunRecord({
        ...running,
        runId: "queued-collector",
        childSessionKey: "agent:main:subagent:queued-collector",
        controllerSessionKey: kind.endsWith("tree")
          ? running.childSessionKey
          : controllerSessionKey,
        requesterSessionKey: kind.endsWith("tree") ? running.childSessionKey : controllerSessionKey,
        execution: { status: "queued" },
        swarmLaunchPending: true,
      });
      addSubagentRunForTests(running);
      addSubagentRunForTests(queued);
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
        clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
      });
      const controller = {
        controllerSessionKey,
        controllerAgentId: "main",
        callerSessionKey: controllerSessionKey,
        callerIsSubagent: false,
        controlScope: "children" as const,
      };
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
        } else if (kind === "bulk") {
          expect(
            await killAllControlledSubagentRuns({ cfg, controller, runs: [running, queued] }),
          ).toMatchObject({ status: "ok", killed: 2 });
        } else if (kind === "controlled tree") {
          expect(
            await killAllControlledSubagentRuns({ cfg, controller, runs: [running] }),
          ).toMatchObject({ status: "ok", killed: 2 });
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
        expect(controlRuntimeMocks.abortEmbeddedAgentRun).toHaveBeenCalledOnce();
        for (const entry of [running, queued]) {
          expect(getSubagentRunByChildSessionKey(entry.childSessionKey)).toMatchObject({
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

  it.each([
    "intent write",
    "tombstone write",
    "claim release",
    "session replacement at intent",
    "session replacement release",
    "abort refusal",
    "session replacement",
    "row replacement",
    "lifecycle rotation",
    "parent persistence",
  ])("releases or withdraws the exact queued reservation after %s failure", async (failure) => {
    const controllerSessionKey = "agent:main:main";
    const entry = createSubagentRunRecord({
      runId: "failure-queued",
      childSessionKey: "agent:main:subagent:failure-queued",
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "queued failure",
      createdAt: 1,
      generation: 1,
      collect: true,
      swarmLaunchPending: true,
      execution: { status: "queued" },
    });
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("queue-failure", {
      [entry.childSessionKey]: { sessionId: "queued-session", updatedAt: 1 },
    });
    const dispatch = vi.fn(async () => {});
    const reserve = () =>
      enqueueSwarmRun({
        groupId: "failure-lane",
        runId: entry.runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start: dispatch,
        onStartFailure: () => true,
      });
    reserve();
    let writes = 0;
    resetRegistryLeafMocks();
    vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(() => {
      writes += 1;
      if (
        ["session replacement at intent", "session replacement release"].includes(failure) &&
        writes === 1
      ) {
        replaceSessionEntrySync(
          { storePath, sessionKey: entry.childSessionKey },
          { sessionId: "new-session", updatedAt: 2 },
        );
      }
      if (
        (failure === "intent write" && writes === 1) ||
        (["tombstone write", "claim release", "session replacement release"].includes(failure) &&
          writes === 2)
      ) {
        throw new Error("sqlite busy");
      }
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => {
        if (failure === "session replacement") {
          replaceSessionEntrySync(
            { storePath, sessionKey: entry.childSessionKey },
            { sessionId: "new-session", updatedAt: 2 },
          );
        }
        return ["abort refusal", "claim release"].includes(failure);
      },
      abortEmbeddedAgentRun: () => !["abort refusal", "claim release"].includes(failure),
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });
    try {
      const pending = killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey,
          controllerAgentId: "main",
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [entry],
        beforeKill: async () => {
          await Promise.resolve();
          expect(
            dispatch,
            "scheduled pump cannot dispatch while cancellation owns the reservation",
          ).not.toHaveBeenCalled();
          if (failure === "row replacement") {
            expect(removeQueuedSwarmRun(entry.runId)).toBe(true);
            addSubagentRunForTests({ ...entry, generation: 2, createdAt: 2 });
            reserve();
          }
          if (failure === "lifecycle rotation") {
            rotateAgentEventLifecycleGeneration();
          }
          if (failure === "parent persistence") {
            throw new Error("partial persistence failed");
          }
          return true;
        },
      });
      if (failure === "parent persistence") {
        await expect(pending).rejects.toThrow("partial persistence failed");
      } else {
        const result = await pending;
        expect(result.killed).toBe(0);
        expect(result.status).toBe(
          ["row replacement", "lifecycle rotation"].includes(failure) ? "ok" : "error",
        );
      }
      if (["tombstone write", "claim release", "session replacement release"].includes(failure)) {
        expect(entry.killIntent).toMatchObject({ reason: "killed" });
        const survivor = vi.fn(async () => {});
        enqueueSwarmRun({
          groupId: "failure-lane",
          runId: "survivor",
          maxConcurrent: 1,
          activeRunIds: [],
          start: survivor,
          onStartFailure: () => true,
        });
        await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce());
        expect(dispatch).not.toHaveBeenCalled();
        expect(markSubagentRunTerminated({ runId: entry.runId })).toBe(1);
        expect(entry.collectorCompletion).toMatchObject({ status: "killed" });
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(entry.killIntent).toBeUndefined();
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        expect(
          getSubagentRunByChildSessionKey(entry.childSessionKey)?.execution.endedAt,
        ).toBeUndefined();
      }
    } finally {
      swarmSchedulerTesting.reset();
    }
  });

  it.each([false, true])(
    "preserves exactRunId=%s authority when an in-flight launch remaps the same row",
    async (exactRunId) => {
      const runId = "launch-before-admission";
      const childSessionKey = "agent:main:subagent:launch-remap";
      const controllerSessionKey = "agent:main:main";
      const entry = createSubagentRunRecord({
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
      addSubagentRunForTests(entry);
      const sessionId = "launch-remap-session";
      const storePath = await writeSessionStoreFixture("launch-remap", {
        [childSessionKey]: { sessionId, updatedAt: 1 },
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
            expect(startQueuedSubagentRun(runId, "accepted-launch")).toBe(true);
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
        clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
      });
      try {
        await started.promise;
        const cfg = cfgWithSessionStore(storePath);
        if (exactRunId) {
          expect(
            await killSubagentRunAdmin({ cfg, sessionKey: childSessionKey, expectedRunId: runId }),
          ).toMatchObject({ killed: true });
          expect(controlRuntimeMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
        } else {
          expect(
            await killAllControlledSubagentRuns({
              cfg,
              runs: [entry],
              controller: {
                controllerSessionKey,
                controllerAgentId: "main",
                callerSessionKey: controllerSessionKey,
                callerIsSubagent: false,
                controlScope: "children",
              },
            }),
          ).toMatchObject({ killed: 1 });
          expect(controlRuntimeMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
        }
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("accepted-launch");
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
    for (const entry of entries) {
      addSubagentRunForTests(entry);
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

  it.each(["bulk", "channel stop"])(
    "continues %s cancellation after one registry persistence failure",
    async (kind) => {
      let failNextPersistence = true;
      let persistedAfterFailure = false;
      vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(() => {
        if (failNextPersistence) {
          failNextPersistence = false;
          throw new Error("sqlite busy");
        }
        persistedAfterFailure = true;
      });
      const first = createSubagentRunRecord({
        runId: "run-bulk-persistence-failure-first",
        childSessionKey: "agent:main:subagent:bulk-persistence-failure-first",
        controllerSessionKey: "agent:main:main",
        task: "first bulk task",
        createdAt: Date.now() - 2_000,
        startedAt: Date.now() - 1_900,
      });
      const second = createSubagentRunRecord({
        ...first,
        runId: "run-bulk-persistence-failure-second",
        childSessionKey: "agent:main:subagent:bulk-persistence-failure-second",
        task: "second bulk task",
        createdAt: Date.now() - 1_000,
        execution: { status: "running", startedAt: Date.now() - 900 },
      });
      addSubagentRunForTests(first);
      addSubagentRunForTests(second);

      if (kind === "channel stop") {
        expect(
          await stopSubagentsForRequester({
            cfg: cfgWithSessionStore(),
            requesterSessionKey: "agent:main:main",
          }),
        ).toEqual({ stopped: 1, failed: 1 });
      } else {
        const result = await killAllControlledSubagentRuns({
          cfg: cfgWithSessionStore(),
          controller: controllerFor(),
          runs: [first, second],
        });

        expect(result).toEqual({
          status: "error",
          error: "first bulk task: Failed to persist subagent kill intent: sqlite busy",
          failed: 1,
          killed: 1,
          labels: ["second bulk task"],
        });
      }
      expect(persistedAfterFailure).toBe(true);
      expect(
        getSubagentRunByChildSessionKey(first.childSessionKey)?.execution.endedAt,
      ).toBeUndefined();
      expect(getSubagentRunByChildSessionKey(second.childSessionKey)?.execution.endedAt).toBeTypeOf(
        "number",
      );
    },
  );

  it("ignores stale same-id generations in bulk kill requests", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-same-bulk",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current bulk task",
      generation: 2,
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(),
      runs: [
        createSubagentRunRecord({
          runId: "run-same-bulk",
          childSessionKey,
          controllerSessionKey: "agent:main:main",
          task: "stale bulk task",
          generation: 1,
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        }),
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-same-bulk",
      generation: 2,
    });
  });

  it("does not let a stale bulk entry suppress the current yielded entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all-shadow", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    const currentShadowRun = createSubagentRunRecord({
      runId: "run-current-shadow",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current shadow task",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
      endedAt: Date.now() - 2_000,
      pauseReason: "sessions_yield",
    });
    addSubagentRunForTests(currentShadowRun);

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: controllerFor(),
      runs: [
        createSubagentRunRecord({
          runId: "run-stale-shadow",
          childSessionKey,
          controllerSessionKey: "agent:main:main",
          task: "stale shadow task",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        }),
        currentShadowRun,
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["current shadow task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
  });

  it("does not kill a newest finished bulk target when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:stale-bulk-finished-worker";

    addSubagentRunForTests({
      runId: "run-stale-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "stale bulk finished task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    const currentBulkFinishedRun = createSubagentRunRecord({
      runId: "run-current-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current bulk finished task",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests(currentBulkFinishedRun);

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: controllerFor(),
      runs: [currentBulkFinishedRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
  });

  it("cascades through descendants for an ended current bulk target even when a stale older row is still active", async () => {
    const parentSessionKey = "agent:main:subagent:stale-bulk-desc-parent";
    const childSessionKey = `${parentSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      runId: "run-stale-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "stale bulk parent task",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    const currentBulkParentRun = createSubagentRunRecord({
      runId: "run-current-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      task: "current bulk parent task",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests(currentBulkParentRun);
    addSubagentRunForTests({
      runId: "run-active-bulk-desc-child",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "active bulk child task",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: controllerFor(),
      runs: [currentBulkParentRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["active bulk child task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
  });
});

describe("controlled subagent reads", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

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
      addSubagentRunForTests({
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
    addSubagentRunForTests({
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
    addSubagentRunForTests({
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

    addSubagentRunForTests({
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
      addSubagentRunForTests({
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
