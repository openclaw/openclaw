import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { CreatedDetachedTaskRun } from "../../../tasks/detached-task-runtime-contract.js";
import type { prepareRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { createQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";

const mocks = vi.hoisted(() => ({
  register: vi.fn<SubagentLaunchManager["registerSubagentRun"]>(),
  persisted: new Set<() => void>(),
  prepare: vi.fn<typeof prepareRunningTaskRun>(),
  createLegacy: vi.fn<() => TaskRecord | null>(),
  lifecycle: "original",
  context: undefined as OpenClawStateWorkerContext | undefined,
}));
vi.mock("../../../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: () => undefined,
}));
vi.mock("../../../infra/agent-events.js", () => ({
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: () => () => {},
  getAgentEventLifecycleGeneration: () => mocks.lifecycle,
  isAgentEventLifecycleGenerationCurrent: (value: string) => value === mocks.lifecycle,
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => mocks.context,
}));
vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  prepareRunningTaskRun: mocks.prepare,
  createQueuedTaskRun: vi.fn(),
  createRunningTaskRun: mocks.createLegacy,
  finalizeTaskRunByRunId: vi.fn(),
  startTaskRunByRunId: vi.fn(),
}));
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => undefined,
}));

function task(): TaskRecord {
  return {
    taskId: "task",
    runtime: "subagent",
    runId: "running-original",
    childSessionKey: "agent:main:subagent:synthetic",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "synthetic running work",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
  };
}

function fixture() {
  const f = createQueuedRegistrationFixture(mocks, subagentRuns);
  Object.assign(f.registration, {
    runId: "running-original",
    queued: false,
    collect: false,
    queuedLaunch: undefined,
  });
  vi.spyOn(f.manager, "waitForSubagentCompletion").mockResolvedValue(undefined);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persisted.clear();
  subagentRuns.clear();
  mocks.lifecycle = "original";
  mocks.createLegacy.mockReturnValue(task());
  mocks.context = {
    admission: {
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "original", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
  };
  mocks.prepare.mockReturnValue({ kind: "legacy", task: task(), finalizeRun: () => [] });
});
afterEach(() => {
  subagentRuns.clear();
  vi.restoreAllMocks();
});

it("publishes only after acknowledgement and joins task creation before activating", async () => {
  const f = fixture();
  const entered = createDeferred();
  const creation = createDeferred<CreatedDetachedTaskRun>();
  const release = vi.fn();
  mocks.prepare.mockReturnValue({
    kind: "receipt",
    create: () => {
      entered.resolve();
      return creation.promise;
    },
  });
  const pending = f.register();
  expect(f.runs.has(f.registration.runId)).toBe(false);
  expect(f.writes[0]?.snapshot.get(f.registration.runId)).toMatchObject({
    execution: { status: "running" },
  });
  expect(mocks.prepare).not.toHaveBeenCalled();
  f.writes[0]!.gate.resolve();
  await entered.promise;
  expect(f.runs.has(f.registration.runId)).toBe(true);
  expect(f.options.ensureListener).not.toHaveBeenCalled();
  expect(f.scope.canLaunch()).toBe(false);
  creation.resolve({
    task: task(),
    release,
    bindRunOwner: async () => {
      throw new Error("Registry registration must not acquire the execution owner");
    },
    finalizeActive: async () => {},
    settleUnstarted: async () => false,
  });
  await pending;
  expect(f.scope.canLaunch()).toBe(true);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
});

it("keeps the acknowledged row visible until a required no-task rollback commits", async () => {
  const f = fixture();
  const previous = createSubagentRunRecord({
    runId: "previous",
    childSessionKey: f.registration.childSessionKey,
    generation: 1,
    createdAt: 1,
    execution: { status: "terminal", endedAt: 2 },
    killReconciliation: { killedAt: 2 },
  });
  f.runs.set(previous.runId, previous);
  mocks.prepare.mockReturnValue({ kind: "legacy", task: null, finalizeRun: () => [] });
  const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
  expect(previous.killReconciliation).toEqual({ killedAt: 2 });
  f.writes[0]!.gate.resolve();
  const rollback = await f.waitForWrite(1);
  expect(previous.killReconciliation?.supersededAt).toBeTypeOf("number");
  expect(f.runs.has(f.registration.runId)).toBe(true);
  expect(rollback.snapshot.has(f.registration.runId)).toBe(false);
  expect(f.scope.canCleanupSession()).toBe(false);
  rollback.assertCurrent();
  rollback.gate.resolve();
  expect(await pending).toMatchObject({ message: expect.stringContaining("created no task row") });
  expect(f.runs.has(f.registration.runId)).toBe(false);
  expect(previous.killReconciliation).toEqual({ killedAt: 2 });
  expect(f.scope.canCleanupSession()).toBe(true);
  expect(f.options.ensureListener).not.toHaveBeenCalled();
});

it.each(["not-committed", "unknown"] as const)(
  "preserves the %s write outcome without publication or replay",
  async (outcome) => {
    const f = fixture();
    const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
    const failure = new SubagentRegistryWriteError(outcome, new Error("write failed"));
    f.writes[0]!.gate.reject(failure);
    expect(await pending).toBe(failure);
    expect(f.runs.has(f.registration.runId)).toBe(false);
    expect(f.scope.canCleanupSession()).toBe(outcome === "not-committed");
    expect(f.scope.canAcceptLaunch()).toBe(false);
    expect(f.scope.canAbortAcceptedRun()).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
  },
);

it.each(["required", "optional"] as const)(
  "retains committed registry ownership when %s core task creation has no receipt",
  async (ownership) => {
    const f = fixture();
    if (ownership === "optional") {
      f.registration.taskRowOwnership = undefined;
    }
    const failure = new Error("task result lost after admission");
    mocks.prepare.mockReturnValue({
      kind: "receipt",
      create: async () => {
        throw failure;
      },
    });
    const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
    f.writes[0]!.gate.resolve();
    expect(await pending).toBe(ownership === "required" ? failure : undefined);
    expect(f.runs.has(f.registration.runId)).toBe(true);
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.scope.canLaunch()).toBe(ownership === "optional");
    expect(f.options.ensureListener).toHaveBeenCalledTimes(ownership === "optional" ? 1 : 0);
    expect(f.writes).toHaveLength(1);
  },
);

it("keeps an acknowledged old run tracked when a different run owns the child before publication", async () => {
  const f = fixture();
  const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
  const captured = f.writes[0]!.snapshot.get(f.registration.runId)!;
  const successor = createSubagentRunRecord({ ...captured, runId: "successor", generation: 2 });
  f.runs.set(successor.runId, successor);
  subagentRuns.commitOwnership(successor);
  f.writes[0]!.gate.resolve();
  expect(await pending).toMatchObject({ message: expect.stringContaining("owner changed") });
  expect(f.runs.get(f.registration.runId)).toEqual(captured);
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
  expect(f.manager.waitForSubagentCompletion).toHaveBeenCalledWith(
    f.registration.runId,
    expect.any(Number),
    f.runs.get(f.registration.runId),
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(f.scope.canAbortAcceptedRun()).toBe(false);
  expect(f.writes).toHaveLength(1);
});

it.each(["same run", "different run"] as const)(
  "retains a %s successor that commits and retires during task creation",
  async (replacement) => {
    const f = fixture();
    const entered = createDeferred();
    const creation = createDeferred<CreatedDetachedTaskRun>();
    const release = vi.fn();
    const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
      async (_terminal, canSettle) => canSettle(task()),
    );
    mocks.prepare.mockReturnValue({
      kind: "receipt",
      create: () => {
        entered.resolve();
        return creation.promise;
      },
    });
    const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
    f.writes[0]!.gate.resolve();
    await entered.promise;
    const successor = createSubagentRunRecord({
      ...f.runs.get(f.registration.runId)!,
      runId: replacement === "same run" ? f.registration.runId : "successor",
      generation: 2,
    });
    f.runs.set(successor.runId, successor);
    subagentRuns.commitOwnership(successor);
    f.runs.delete(successor.runId);
    creation.resolve({
      task: task(),
      release,
      settleUnstarted,
      bindRunOwner: async () => {
        throw new Error("unused");
      },
      finalizeActive: async () => {},
    });
    expect(await pending).toMatchObject({ message: expect.stringContaining("owner changed") });
    expect(f.runs.has(f.registration.runId)).toBe(replacement === "different run");
    expect(settleUnstarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "failed", suppressDelivery: true }),
      expect.any(Function),
    );
    expect(await settleUnstarted.mock.results[0]!.value).toBe(replacement === "different run");
    expect(f.writes).toHaveLength(1);
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.scope.canAbortAcceptedRun()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(f.options.ensureListener).toHaveBeenCalledTimes(replacement === "different run" ? 1 : 0);
  },
);
