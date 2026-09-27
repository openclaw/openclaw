import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { revokePluginRecord } from "../../../plugins/registry-lifecycle.js";
import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import * as databaseLifecycle from "../../../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { DetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime-contract.js";
import {
  setDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import {
  createInMemoryTaskRegistryStore,
  createInMemoryTaskFlowRegistryStore,
} from "../../../test-utils/task-registry-store.js";
import { runSpawnPipeline } from "../../spawn-pipeline.js";
import { holdQueuedSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { registerQueuedRegistrationAdmissionCases } from "./subagent-registry-queued-admission.test-support.js";
import { registerQueuedCancelledLaunchCases } from "./subagent-registry-queued-cancelled-launch.test-support.js";
import { registerQueuedRegistrationNoTaskCases } from "./subagent-registry-queued-no-task.test-support.js";
import { registerQueuedRegistrationClaimCases } from "./subagent-registry-queued-registration-claims.test-support.js";
import { createQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import * as registryState from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  register: vi.fn<SubagentLaunchManager["registerSubagentRun"]>(),
  persisted: new Set<() => void>(),
  databaseListeners: new Set<
    Parameters<typeof databaseLifecycle.registerOpenClawStateDatabaseLifecycleListener>[0]
  >(),
  runtime: undefined as DetachedTaskLifecycleRuntime | undefined,
  createTask: vi.fn<typeof import("../../../tasks/detached-task-runtime.js").createQueuedTaskRun>(),
  lifecycle: "original",
  database: "original-db",
  context: undefined as OpenClawStateWorkerContext | undefined,
}));
vi.mock("./subagent-registry.js", () => ({
  registerSubagentRun: mocks.register,
  completeCollectorLaunchCleanup: vi.fn(),
  settleFailedQueuedSubagentLaunch: vi.fn(),
  startQueuedSubagentRun: vi.fn(),
}));
vi.mock("../../../infra/agent-events.js", () => ({
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: () => () => {},
  getAgentEventLifecycleGeneration: () => mocks.lifecycle,
  isAgentEventLifecycleGenerationCurrent: (value: string) => value === mocks.lifecycle,
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    ...mocks.context,
    admission: {
      ...mocks.context?.admission,
      identity: { key: mocks.database, canonicalPath: "/synthetic/state.sqlite" },
    },
  }),
}));
vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  getDetachedTaskLifecycleRuntime: () => mocks.runtime,
  createQueuedTaskRun: mocks.createTask,
  createRunningTaskRun: mocks.createTask,
  finalizeTaskRunByRunId: vi.fn(),
  startTaskRunByRunId: vi.fn(),
}));
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => undefined,
}));

function makeTask(taskId = "task"): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    runId: "queued-original",
    childSessionKey: "agent:main:subagent:synthetic",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "synthetic queued work",
    status: "queued",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
  };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  mocks.persisted.clear();
  mocks.databaseListeners.clear();
  vi.spyOn(databaseLifecycle, "registerOpenClawStateDatabaseLifecycleListener").mockImplementation(
    (listener) => {
      mocks.databaseListeners.add(listener);
      return () => {
        mocks.databaseListeners.delete(listener);
      };
    },
  );
  vi.spyOn(registryState, "onSubagentRegistryPersisted").mockImplementation((listener) => {
    mocks.persisted.add(listener);
    return () => {
      mocks.persisted.delete(listener);
    };
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore(), observers: null });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  vi.clearAllMocks();
  mocks.lifecycle = "original";
  mocks.database = "original-db";
  mocks.createTask.mockReset().mockReturnValue(makeTask());
  mocks.runtime = {
    createQueuedTaskRun: mocks.createTask,
    createRunningTaskRun: mocks.createTask,
    startTaskRunByRunId: () => [],
    recordTaskRunProgressByRunId: () => [],
    completeTaskRunByRunId: () => [],
    setDetachedTaskDeliveryStatusByRunId: () => [],
    cancelDetachedTaskRunById: async () => ({ found: false, cancelled: false }),
    finalizeTaskRunByRunId: vi.fn<
      NonNullable<DetachedTaskLifecycleRuntime["finalizeTaskRunByRunId"]>
    >((params) => [
      { ...makeTask(), status: "failed", endedAt: params.endedAt, error: params.error },
    ]),
    failTaskRunByRunId: vi.fn<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>((params) => [
      { ...makeTask(), status: "failed", endedAt: params.endedAt, error: params.error },
    ]),
  };
  setDetachedTaskLifecycleRuntime(mocks.runtime, "queued-registration-fixture");
  mocks.context = {
    admission: {
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "original-db", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
  };
  schedulerTesting.reset();
});

afterEach(() => {
  resetDetachedTaskLifecycleRuntimeForTests();
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

const fixture = () => createQueuedRegistrationFixture(mocks);

it("awaits both registry acknowledgements through the spawn pipeline before publishing success", async () => {
  const f = fixture();
  const cleanup = vi.fn(async () => {});
  const release = vi.fn();
  let completed = false;
  const result = runSpawnPipeline({
    adapter: {
      initialize: async () => ({}),
      dispatchTurn: async () => ({ runId: f.registration.runId }),
      cleanupOnFailure: cleanup,
    },
    buildRegistration: () => f.registration,
    progressSessionKey: "agent:main:main",
    admissionReservation: { release },
  }).then((value) => {
    completed = true;
    return value;
  });
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
  expect(mocks.createTask).not.toHaveBeenCalled();
  expect(completed).toBe(false);
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  expect(mocks.createTask).toHaveBeenCalledOnce();
  expect(f.writes[1]!.snapshot.get(f.registration.runId)?.queuedLaunch).toEqual(
    f.registration.queuedLaunch,
  );
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
  expect(release).not.toHaveBeenCalled();
  f.writes[1]!.gate.resolve();
  expect(await result).toMatchObject({ ok: true });
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toEqual(f.registration.queuedLaunch);
  expect(cleanup).not.toHaveBeenCalled();
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
});

it.each(["same-id", "different-id", "lifecycle", "database"] as const)(
  "rejects %s replacement without task creation or successor cleanup",
  async (replacement) => {
    const f = fixture();
    reserveSwarmRun({
      groupId: "group",
      runId: f.registration.runId,
      maxConcurrent: 1,
      activeRunIds: [],
    });
    const reservation = holdQueuedSwarmRun(f.registration.runId)!;
    const completion = f.register();
    const rejected = expect(completion).rejects.toThrow("original run owner");
    const original = f.runs.get(f.registration.runId)!;
    let successor: SubagentRunRecord | undefined;
    if (replacement === "same-id" || replacement === "different-id") {
      successor = {
        ...structuredClone(original),
        runId: replacement === "same-id" ? original.runId : "successor",
        generation: (original.generation ?? 0) + 1,
      };
      f.runs.set(successor.runId, successor);
    } else if (replacement === "lifecycle") {
      mocks.lifecycle = "successor";
    } else {
      mocks.database = "successor-db";
    }
    f.writes[0]!.gate.resolve();
    // A different-ID successor can leave the original terminal failure to be persisted.
    if (replacement === "different-id") {
      await vi.waitFor(() => expect(f.writes).toHaveLength(2));
      f.writes[1]!.gate.resolve();
    }
    await rejected;
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.scope.canRetireReservation()).toBe(true);
    expect(reservation.withdraw()).toBe(true);
    await reservation.release();
    if (successor) {
      expect(f.runs.get(successor.runId)).toBe(successor);
    }
  },
);

it.each(["intent", "publication", "rollback"] as const)(
  "keeps an uncertain %s write nonlaunchable without retrying persistence",
  async (phase) => {
    const f = fixture();
    if (phase === "rollback") {
      mocks.createTask.mockReturnValue(null);
    }
    const completion = f.register();
    if (phase !== "intent") {
      f.writes[0]!.gate.resolve();
      await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    }
    const index = phase === "intent" ? 0 : 1;
    const failure = new SubagentRegistryWriteError("unknown", new Error("lost acknowledgement"));
    const rejected = Promise.resolve(completion).catch((error: unknown) => error);
    f.writes[index]!.gate.reject(failure);
    const reported = await rejected;
    if (phase === "rollback") {
      expect(reported).toMatchObject({
        errors: [expect.any(Error), failure],
        cause: expect.any(Error),
      });
    } else {
      expect(reported).toBe(failure);
    }
    await expect(f.scope.settleFailedLaunch("retained failure callback")).rejects.toBe(reported);
    await expect(f.scope.settleFailedLaunch("repeated failure callback")).rejects.toBe(reported);
    mocks.lifecycle = "retired";
    await expect(f.scope.settleFailedLaunch("retired failure callback")).resolves.toBeUndefined();
    expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
    expect(f.scope.canLaunch()).toBe(false);
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(mocks.createTask).toHaveBeenCalledTimes(index);
    expect(f.writes).toHaveLength(index + 1);
  },
);

it("preserves an intervening terminal tombstone when creation reports no task", async () => {
  const f = fixture();
  mocks.createTask.mockImplementation(() => {
    const entry = f.runs.get(f.registration.runId)!;
    entry.execution = { ...entry.execution, status: "terminal", endedAt: 55 };
    entry.killReconciliation = { killedAt: 55 };
    return null;
  });
  const completion = f.register();
  const rejected = expect(completion).rejects.toThrow("created no task row");
  f.writes[0]!.gate.resolve();
  await rejected;
  expect(f.runs.get(f.registration.runId)?.execution).toMatchObject({
    status: "terminal",
    endedAt: 55,
  });
  expect(f.writes).toHaveLength(1);
});

it("preserves synchronous optional queued registration", () => {
  const f = fixture();
  expect(
    f.manager.registerSubagentRun({ ...f.registration, taskRowOwnership: undefined }),
  ).toBeUndefined();
  expect(mocks.createTask).toHaveBeenCalledOnce();
  expect(f.options.persistOrThrow).toHaveBeenCalledOnce();
  expect(f.writes).toHaveLength(0);
});

it("persists a known task result when its creation observer closes the spawning parent", async () => {
  const f = fixture();
  let active = true;
  mocks.createTask.mockImplementation(() => {
    active = false;
    return makeTask();
  });
  const completion = f.manager.registerSubagentRun(f.registration, {
    assertCurrent: () => {
      if (!active) {
        throw new Error("parent closed");
      }
    },
  });
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  expect(() => f.writes[1]!.assertCurrent()).not.toThrow();
  f.writes[1]!.gate.resolve();
  await completion;
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toEqual(f.registration.queuedLaunch);
  expect(mocks.createTask).toHaveBeenCalledOnce();
});

it("preserves Stop while the descriptor acknowledgement is pending", async () => {
  const f = fixture();
  const completion = f.register();
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  const entry = f.runs.get(f.registration.runId)!;
  entry.execution = { ...entry.execution, status: "terminal", endedAt: 123 };
  entry.killReconciliation = { killedAt: 123 };
  f.writes[1]!.gate.resolve();
  await completion;
  expect(entry.execution).toMatchObject({ status: "terminal", endedAt: 123 });
  expect(entry.queuedLaunch).toBeUndefined();
  expect(f.scope.canLaunch()).toBe(false);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
});

it("joins known-absent rollback before rejecting registration", async () => {
  const f = fixture();
  mocks.createTask.mockReturnValue(null);
  const completion = f.register();
  const rejection = expect(completion).rejects.toThrow("created no task row");
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes[1]!.snapshot.has(f.registration.runId)).toBe(false);
  f.writes[1]!.gate.resolve();
  await rejection;
  expect(f.runs.has(f.registration.runId)).toBe(false);
});

it("preserves descriptorless recovery when task creation throws without a receipt", async () => {
  const f = fixture();
  const taskError = new Error("task creation outcome unavailable");
  mocks.createTask.mockImplementation(() => {
    throw taskError;
  });
  const completion = f.register();
  const rejection = expect(completion).rejects.toBe(taskError);
  f.writes[0]!.gate.resolve();
  await rejection;
  expect(f.writes).toHaveLength(1);
  expect(f.runs.get(f.registration.runId)?.execution.status).toBe("queued");
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(mocks.createTask).toHaveBeenCalledOnce();
});

it.each(["running", "terminal"] as const)(
  "retains acceptance authority when a %s event precedes the Gateway response",
  async (status) => {
    const f = fixture();
    const completion = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await completion;
    const entry = f.runs.get(f.registration.runId)!;
    entry.execution = {
      ...entry.execution,
      status,
      startedAt: 10,
      ...(status === "terminal" ? { endedAt: 20 } : {}),
    };
    expect(f.scope.canLaunch()).toBe(false);
    expect(f.scope.canAcceptLaunch()).toBe(true);
  },
);

it("terminalizes only the original intent when a successor prevents its first commit", async () => {
  const f = fixture();
  const completion = f.register();
  const original = f.runs.get(f.registration.runId)!;
  const successor = {
    ...structuredClone(original),
    runId: "successor",
    generation: (original.generation ?? 0) + 1,
  };
  f.runs.set(successor.runId, successor);
  const rejection = new SubagentRegistryWriteError("not-committed", new Error("successor won"));
  const failed = expect(completion).rejects.toBe(rejection);
  f.writes[0]!.gate.reject(rejection);
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes[1]!.snapshot.get(original.runId)?.execution).toMatchObject({
    status: "terminal",
    suppressSessionEffects: true,
  });
  expect(original.execution.status).toBe("queued");
  expect(successor.execution.status).toBe("queued");
  f.writes[1]!.gate.resolve();
  await failed;
  expect(original.execution.status).toBe("terminal");
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(mocks.createTask).not.toHaveBeenCalled();
});

it("settles a retained failed launch against its original row after a different-ID replacement", async () => {
  const f = fixture();
  const completion = f.register();
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  f.writes[1]!.gate.resolve();
  await completion;
  const original = f.runs.get(f.registration.runId)!;
  const successor = {
    ...structuredClone(original),
    runId: "successor",
    generation: (original.generation ?? 0) + 1,
  };
  f.runs.set(successor.runId, successor);
  const settlement = f.scope.settleFailedLaunch("superseded during Gateway admission");
  expect(f.writes).toHaveLength(3);
  expect(f.writes[2]!.snapshot.get(original.runId)?.execution.status).toBe("queued");
  expect(f.writes[2]!.snapshot.get(original.runId)?.queuedLaunch).toBeUndefined();
  f.writes[2]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(4));
  expect(f.writes[3]!.snapshot.get(original.runId)?.execution).toMatchObject({
    status: "terminal",
    suppressSessionEffects: true,
  });
  expect(original.execution.status).toBe("queued");
  f.writes[3]!.gate.resolve();
  await settlement;
  expect(original.execution.status).toBe("terminal");
  expect(original.queuedLaunch).toBeUndefined();
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(successor.execution.status).toBe("queued");
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
});

it("retains descriptorless recovery when a known task outlives failed descriptor publication", async () => {
  const f = fixture();
  const completion = f.register();
  const failure = new SubagentRegistryWriteError("not-committed", new Error("descriptor rejected"));
  const rejected = expect(completion).rejects.toBe(failure);
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  f.writes[1]!.gate.reject(failure);
  await rejected;
  expect(mocks.createTask).toHaveBeenCalledOnce();
  expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
  expect(f.scope.canLaunch()).toBe(false);
  expect(f.scope.canCleanupSession()).toBe(false);
  await expect(f.scope.settleFailedLaunch("late failure callback")).rejects.toBe(failure);
  expect(f.writes).toHaveLength(2);
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
});

it.each(["not-committed", "unknown"] as const)(
  "does not lose a %s terminal settlement on the next failure callback",
  async (outcome) => {
    const f = fixture();
    const completion = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await completion;
    const original = f.runs.get(f.registration.runId)!;
    const successor = {
      ...structuredClone(original),
      runId: "successor",
      generation: (original.generation ?? 0) + 1,
    };
    f.runs.set(successor.runId, successor);
    const failure = new SubagentRegistryWriteError(outcome, new Error("terminal write failed"));
    const first = f.scope.settleFailedLaunch("original failure");
    f.writes[2]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(4));
    const rejected = expect(first).rejects.toMatchObject({
      errors: ["original failure", failure],
      cause: "original failure",
    });
    f.writes[3]!.gate.reject(failure);
    await rejected;
    const second = f.scope.settleFailedLaunch("retry failure callback");
    if (outcome === "not-committed") {
      expect(f.writes).toHaveLength(5);
      expect(f.writes[4]!.snapshot.get(original.runId)?.execution).toEqual(
        f.writes[3]!.snapshot.get(original.runId)?.execution,
      );
      f.writes[4]!.gate.resolve();
      await second;
    } else {
      await expect(second).rejects.toMatchObject({
        errors: ["original failure", failure],
        cause: "original failure",
      });
      expect(f.writes).toHaveLength(4);
    }
    expect(f.runs.get(successor.runId)).toBe(successor);
    expect(successor.execution.status).toBe("queued");
  },
);

it.each(["unchanged", "Stop", "same-ID successor"] as const)(
  "withholds terminal cleanup from live readers until acknowledgement with %s",
  async (change) => {
    const f = fixture();
    const taskError = new Error("task creation failed");
    let active = true;
    const completion = f.register(() => {
      if (!active) {
        throw taskError;
      }
    });
    const rejected = expect(completion).rejects.toBe(taskError);
    const original = f.runs.get(f.registration.runId)!;
    const originalExecution = original.execution;
    f.writes[0]!.assertCurrent();
    active = false;
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    try {
      expect(f.writes[1]!.snapshot.get(original.runId)?.execution.status).toBe("terminal");
      expect(original.execution).toBe(originalExecution);
      expect(original.execution.status).toBe("queued");
      expect(original.execution.endedAt).toBeUndefined();
      expect(original.collectorLaunchCleanupPending).toBeUndefined();
      expect(original.collectorCompletion).toBeUndefined();
      if (change === "Stop") {
        original.execution = { ...original.execution, status: "terminal", endedAt: 123 };
        original.killReconciliation = { killedAt: 123 };
      } else if (change === "same-ID successor") {
        f.runs.set(original.runId, {
          ...structuredClone(original),
          generation: (original.generation ?? 0) + 1,
        });
      }
    } finally {
      f.writes[1]!.gate.resolve();
      await rejected;
    }
    if (change === "unchanged") {
      expect(original.execution.status).toBe("terminal");
      expect(original.collectorLaunchCleanupPending).toBe(true);
    } else if (change === "Stop") {
      expect(original.execution.endedAt).toBe(123);
      expect(original.killReconciliation).toEqual({ killedAt: 123 });
    } else {
      expect(f.runs.get(original.runId)).not.toBe(original);
      expect(f.runs.get(original.runId)?.execution.status).toBe("queued");
    }
  },
);

it("settles the original descriptor after a different-ID successor wins its acknowledgement", async () => {
  const f = fixture();
  const completion = f.register();
  const rejected = expect(completion).rejects.toThrow("original run owner");
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  const original = f.runs.get(f.registration.runId)!;
  const successor = {
    ...structuredClone(original),
    runId: "successor",
    generation: (original.generation ?? 0) + 1,
  };
  f.runs.set(successor.runId, successor);
  f.writes[1]!.gate.resolve();
  try {
    await vi.waitFor(() => expect(f.writes).toHaveLength(3));
    expect(f.writes[2]!.snapshot.get(original.runId)?.execution.status).toBe("queued");
    expect(f.writes[2]!.snapshot.get(original.runId)?.queuedLaunch).toBeUndefined();
    f.writes[2]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(4));
    expect(f.writes[3]!.snapshot.get(original.runId)).toMatchObject({
      execution: { status: "terminal", suppressSessionEffects: true },
      collectorLaunchCleanupPending: true,
    });
    expect(f.writes[3]!.snapshot.get(original.runId)?.queuedLaunch).toBeUndefined();
  } finally {
    f.writes[3]?.gate.resolve();
    await rejected;
  }
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(successor.execution.status).toBe("queued");
  expect(f.scope.canCleanupSession()).toBe(false);
});

it.each(["backend canonical error", undefined, ""])(
  "preserves returned task failure %j across a refused terminal registry retry",
  async (canonicalError) => {
    const f = fixture();
    let canonical: TaskRecord | undefined;
    const finalize = vi.mocked(mocks.runtime!.finalizeTaskRunByRunId!);
    finalize.mockImplementation((params) => {
      canonical = {
        ...makeTask(),
        status: "failed",
        endedAt: params.endedAt + 123,
        error: canonicalError,
      };
      return [canonical];
    });
    const completion = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await completion;
    const original = f.runs.get(f.registration.runId)!;
    f.runs.set("successor", {
      ...structuredClone(original),
      runId: "successor",
      generation: (original.generation ?? 0) + 1,
    });
    const settlement = f.scope.settleFailedLaunch("launch failed");
    const rejection = expect(settlement).rejects.toThrow("failure could not be persisted");
    f.writes[2]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(4));
    f.writes[3]!.gate.reject(
      new SubagentRegistryWriteError("not-committed", new Error("write admission refused")),
    );
    await rejection;
    const retry = f.scope.settleFailedLaunch("retry with a different message");
    const joined = retry.catch((error: unknown) => error);
    try {
      expect(f.writes).toHaveLength(5);
    } finally {
      f.writes[4]?.gate.resolve();
      await joined;
    }
    await expect(retry).resolves.toBeUndefined();
    expect(original.execution.status).toBe("terminal");
    expect(finalize).toHaveBeenCalledOnce();
    expect(canonical).toBeDefined();
    expect(f.writes[3]!.snapshot.get(original.runId)?.execution.endedAt).toBe(canonical?.endedAt);
    expect(original.execution.endedAt).toBe(canonical?.endedAt);
    expect(
      original.execution.outcome?.status === "error" ? original.execution.outcome.error : undefined,
    ).toBe(canonical?.error);
    expect(f.options.persistOrThrow).not.toHaveBeenCalled();
  },
);

it.each(["missing time", "succeeded", "timed_out", "cancelled", "lost"] as const)(
  "retains recovery without replay when the captured task returns %s",
  async (result) => {
    const f = fixture();
    const finalize = vi.mocked(mocks.runtime!.finalizeTaskRunByRunId!);
    finalize.mockReturnValue([
      {
        ...makeTask(),
        status: result === "missing time" ? "failed" : result,
        endedAt: result === "missing time" ? undefined : 123,
      },
    ]);
    const registered = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await registered;
    const entry = f.runs.get(f.registration.runId)!;
    f.runs.set("successor", {
      ...structuredClone(entry),
      runId: "successor",
      generation: (entry.generation ?? 0) + 1,
    });
    const settlement = f.scope.settleFailedLaunch("original failure");
    const reported = settlement.catch((error: unknown) => error);
    f.writes[2]!.gate.resolve();
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(f.writes).toHaveLength(3);
      const failure = await reported;
      expect(failure).toMatchObject({
        message: "Queued task finalization requires recovery",
        cause: "original failure",
      });
      await expect(f.scope.settleFailedLaunch("repeat callback")).rejects.toBe(failure);
      expect(finalize).toHaveBeenCalledOnce();
      expect(entry.execution.status).toBe("queued");
      expect(entry.queuedLaunch).toBeUndefined();
      expect(f.scope.canCleanupSession()).toBe(false);
    } finally {
      f.acknowledgeAllWrites();
      await reported;
    }
  },
);

it.each(["empty", "throw"] as const)(
  "retains queued recovery after captured finalizer %s",
  async (outcome) => {
    const f = fixture();
    const finalize = vi.fn<NonNullable<DetachedTaskLifecycleRuntime["finalizeTaskRunByRunId"]>>(
      () => {
        if (outcome === "throw") {
          throw new Error("finalizer unavailable");
        }
        return [];
      },
    );
    if (!mocks.runtime) {
      throw new Error("missing task runtime fixture");
    }
    mocks.runtime.finalizeTaskRunByRunId = finalize;
    const completion = f.register();
    const rejection = expect(completion).rejects.toThrow("task finalization requires recovery");
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    const original = f.runs.get(f.registration.runId)!;
    f.runs.set("successor", {
      ...structuredClone(original),
      runId: "successor",
      generation: (original.generation ?? 0) + 1,
    });
    f.writes[1]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(3));
    expect(finalize).not.toHaveBeenCalled();
    expect(f.writes[2]!.snapshot.get(original.runId)).toMatchObject({
      execution: { status: "queued", suppressSessionEffects: true },
    });
    f.writes[2]!.gate.resolve();
    await rejection;
    expect(original.execution.status).toBe("queued");
    expect(original.queuedLaunch).toBeUndefined();
    expect(f.scope.canCleanupSession()).toBe(false);
    await expect(f.scope.settleFailedLaunch("later callback")).rejects.toThrow(
      "task finalization requires recovery",
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(3);
  },
);

it("preserves a same-entry Stop raised by the captured finalizer observer", async () => {
  const f = fixture();
  const finalize = vi.fn<NonNullable<DetachedTaskLifecycleRuntime["finalizeTaskRunByRunId"]>>(
    (params) => {
      const entry = f.runs.get(f.registration.runId)!;
      entry.execution = { ...entry.execution, status: "terminal", endedAt: 123 };
      entry.killReconciliation = { killedAt: 123 };
      return [{ ...makeTask(), status: "failed", endedAt: params.endedAt }];
    },
  );
  if (!mocks.runtime) {
    throw new Error("missing task runtime fixture");
  }
  mocks.runtime.finalizeTaskRunByRunId = finalize;
  const completion = f.register();
  const rejection = expect(completion).rejects.toThrow("original run owner");
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  const original = f.runs.get(f.registration.runId)!;
  f.runs.set("successor", {
    ...structuredClone(original),
    runId: "successor",
    generation: (original.generation ?? 0) + 1,
  });
  f.writes[1]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(3));
  f.writes[2]!.gate.resolve();
  await rejection;
  expect(original.execution.endedAt).toBe(123);
  expect(original.killReconciliation).toEqual({ killedAt: 123 });
  await expect(f.scope.settleFailedLaunch("later callback")).resolves.toBeUndefined();
  expect(finalize).toHaveBeenCalledOnce();
  expect(f.writes).toHaveLength(3);
});

it("rolls back an unpersisted registration when task-owner capture fails", () => {
  const f = fixture();
  const registry = requireActivePluginRegistry();
  const record = registry.plugins.find(
    (candidate) => candidate.id === "queued-registration-fixture",
  )!;
  revokePluginRecord(registry, record);
  expect(() => f.register()).toThrow("no longer active");
  expect(f.runs.has(f.registration.runId)).toBe(false);
  expect(f.writes).toHaveLength(0);
  expect(mocks.createTask).not.toHaveBeenCalled();
});

it("preserves queued recovery when task creation returns a blank task selector", async () => {
  const f = fixture();
  mocks.createTask.mockReturnValue(makeTask(""));
  const completion = f.register();
  const rejection = expect(completion).rejects.toThrow("returned no task ID");
  f.writes[0]!.gate.resolve();
  await rejection;
  expect(f.writes).toHaveLength(1);
  expect(f.runs.get(f.registration.runId)?.execution.status).toBe("queued");
  expect(f.scope.canCleanupSession()).toBe(false);
});

const queuedRegistrationFixtureParams = {
  fixture,
  createTask: mocks.createTask,
  makeTask,
  finalizer: () => mocks.runtime!.finalizeTaskRunByRunId!,
};
registerQueuedRegistrationAdmissionCases(queuedRegistrationFixtureParams);
registerQueuedRegistrationNoTaskCases(queuedRegistrationFixtureParams);
registerQueuedRegistrationClaimCases(queuedRegistrationFixtureParams);
registerQueuedCancelledLaunchCases(queuedRegistrationFixtureParams);

it("retires an uncertain settlement callback after confirmed same-entry Stop", async () => {
  const f = fixture();
  const completion = f.register();
  const failure = new SubagentRegistryWriteError("unknown", new Error("acknowledgement lost"));
  const rejected = expect(completion).rejects.toBe(failure);
  f.writes[0]!.gate.reject(failure);
  await rejected;
  const entry = f.runs.get(f.registration.runId)!;
  entry.execution = { ...entry.execution, status: "terminal", endedAt: 123 };
  entry.killReconciliation = { killedAt: 123 };
  await expect(f.scope.settleFailedLaunch("confirmed Stop took over")).resolves.toBeUndefined();
  expect(entry.execution.endedAt).toBe(123);
  expect(f.writes).toHaveLength(1);
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
});

it.each(["abort", "drain", "replacement", "database retirement"] as const)(
  "disposes claim-wait subscriptions on %s",
  async (retirement) => {
    const f = fixture();
    const work = new AsyncWorkScope();
    mocks.createTask.mockImplementation(() => {
      const entry = f.runs.get(f.registration.runId)!;
      f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
      return makeTask();
    });
    const completion = work.track(() => f.register());
    const rejection = expect(completion).rejects.toThrow();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(mocks.databaseListeners.size).toBe(1));
    try {
      if (retirement === "abort") {
        work.beginClose(new Error("work aborted"));
      } else if (retirement === "drain") {
        markGatewayRestartDraining();
      } else if (retirement === "replacement") {
        const original = f.runs.get(f.registration.runId)!;
        f.runs.set(original.runId, {
          ...structuredClone(original),
          generation: (original.generation ?? 0) + 1,
        });
        f.options.persistOrThrow();
      } else {
        mocks.database = "replacement-db";
        for (const listener of mocks.databaseListeners) {
          listener({
            kind: "closed",
            path: "/synthetic/state.sqlite",
            identity: { key: "original-db", canonicalPath: "/synthetic/state.sqlite" },
          });
        }
      }
      await rejection;
      expect(mocks.persisted.size).toBe(0);
      expect(mocks.databaseListeners.size).toBe(0);
      expect(f.writes).toHaveLength(1);
      expect(f.scope.canCleanupSession()).toBe(false);
    } finally {
      work.beginClose();
      f.acknowledgeAllWrites();
      await work.drain();
    }
  },
);

it("retains its own acknowledged terminal error until a different confirmed Stop takes over", async () => {
  const f = fixture();
  const registration = f.register();
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  f.writes[1]!.gate.resolve();
  await registration;
  const entry = f.runs.get(f.registration.runId)!;
  f.runs.set("successor", {
    ...structuredClone(entry),
    runId: "successor",
    generation: (entry.generation ?? 0) + 1,
  });
  const settlement = f.scope.settleFailedLaunch("launch failed");
  const reported = settlement.catch((error: unknown) => error);
  f.writes[2]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(4));
  const failure = new SubagentRegistryWriteError(
    "committed",
    new Error("publication failed after ACK"),
  );
  f.writes[3]!.afterPublicationFailure = { error: failure };
  f.writes[3]!.gate.resolve();
  const retained = await reported;
  expect(retained).toMatchObject({ errors: ["launch failed", failure], cause: "launch failed" });
  expect(entry.execution.status).toBe("terminal");
  await expect(f.scope.settleFailedLaunch("repeat callback")).rejects.toBe(retained);
  entry.execution = { ...entry.execution, endedAt: 123 };
  entry.killReconciliation = { killedAt: 123 };
  await expect(f.scope.settleFailedLaunch("confirmed Stop")).resolves.toBeUndefined();
  expect(f.writes).toHaveLength(4);
});

it.each(["caller", "Gateway"] as const)(
  "refuses queued task creation when its %s retires during worker admission",
  async (retired) => {
    resetDetachedTaskLifecycleRuntimeForTests();
    const flows = createInMemoryTaskFlowRegistryStore();
    const store = createInMemoryTaskRegistryStore(undefined, flows);
    configureTaskRegistryRuntime({ store, observers: null });
    configureTaskFlowRegistryRuntime({ store: flows });
    const entered = vi.fn();
    const release = createDeferred();
    const mutate = store.runInitialMutationAsync.bind(store);
    store.runInitialMutationAsync = async (context, command, assertCurrent) => {
      if (command.type === "tasks.createRecord") {
        entered();
        await release.promise;
      }
      return mutate(context, command, assertCurrent);
    };
    const f = fixture();
    let active = true;
    const completion = Promise.resolve(
      f.register(() => {
        if (!active) {
          throw new Error("Spawning caller retired before task creation");
        }
      }),
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    f.writes[0]!.gate.resolve();
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      if (retired === "caller") {
        active = false;
      } else {
        bindGatewayContextResolver(f.runs.get(f.registration.runId)!, () => {
          throw new Error("Replacement Gateway must not be used");
        });
      }
    } finally {
      release.resolve();
      f.acknowledgeAllWrites();
      await completion;
    }
    expect(await completion).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(store.loadSnapshot().tasks.size).toBe(0);
    expect(f.writes).toHaveLength(1);
    expect(f.scope.canLaunch()).toBe(false);
  },
);
