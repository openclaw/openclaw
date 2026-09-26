import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import * as databaseLifecycle from "../../../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runSpawnPipeline } from "../../spawn-pipeline.js";
import { holdQueuedSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { registerQueuedRegistrationAdmissionCases } from "./subagent-registry-queued-admission.test-support.js";
import { registerQueuedCancelledLaunchCases } from "./subagent-registry-queued-cancelled-launch.test-support.js";
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
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => undefined,
}));

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
  vi.clearAllMocks();
  mocks.lifecycle = "original";
  mocks.database = "original-db";
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
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
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
  expect(completed).toBe(false);
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
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
  "rejects %s replacement without successor cleanup",
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
    // A different-ID successor needs recovery intent before the original terminal outcome.
    if (replacement === "different-id") {
      await vi.waitFor(() => expect(f.writes).toHaveLength(2));
      expect(f.writes[1]!.snapshot.get(original.runId)).toMatchObject({
        execution: { status: "queued", suppressSessionEffects: true },
        queuedLaunch: undefined,
      });
      expect(original.execution.suppressSessionEffects).toBeUndefined();
      f.writes[1]!.assertCurrent();
      const terminalWrite = f.nextWrite;
      f.writes[1]!.gate.resolve();
      const terminal = await terminalWrite;
      expect(f.writes).toHaveLength(3);
      expect(terminal.snapshot.get(original.runId)).toMatchObject({
        execution: { status: "terminal", suppressSessionEffects: true },
        queuedLaunch: undefined,
        collectorLaunchCleanupPending: true,
      });
      expect(original.execution.status).toBe("queued");
      terminal.assertCurrent();
      terminal.gate.resolve();
    }
    await rejected;
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.scope.canRetireReservation()).toBe(true);
    expect(reservation.withdraw()).toBe(true);
    await reservation.release();
    if (successor) {
      expect(f.runs.get(successor.runId)).toBe(successor);
    }
  },
);

it.each(["intent", "publication"] as const)(
  "keeps an uncertain %s write nonlaunchable without retrying persistence",
  async (phase) => {
    const f = fixture();
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
    expect(reported).toBe(failure);
    await expect(f.scope.settleFailedLaunch("retained failure callback")).rejects.toBe(reported);
    await expect(f.scope.settleFailedLaunch("repeated failure callback")).rejects.toBe(reported);
    mocks.lifecycle = "retired";
    await expect(f.scope.settleFailedLaunch("retired failure callback")).resolves.toBeUndefined();
    expect(f.runs.get(f.registration.runId)?.queuedLaunch).toBeUndefined();
    expect(f.scope.canLaunch()).toBe(false);
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.writes).toHaveLength(index + 1);
  },
);

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
  expect(f.writes[1]!.snapshot.get(original.runId)).toMatchObject({
    execution: { status: "queued", suppressSessionEffects: true },
    queuedLaunch: undefined,
  });
  expect(original.execution.suppressSessionEffects).toBeUndefined();
  f.writes[1]!.assertCurrent();
  const terminalWrite = f.nextWrite;
  f.writes[1]!.gate.resolve();
  const terminal = await terminalWrite;
  expect(f.writes).toHaveLength(3);
  expect(terminal.snapshot.get(original.runId)?.execution).toMatchObject({
    status: "terminal",
    suppressSessionEffects: true,
  });
  expect(original.execution.status).toBe("queued");
  expect(successor.execution.status).toBe("queued");
  terminal.assertCurrent();
  terminal.gate.resolve();
  await failed;
  expect(original.execution.status).toBe("terminal");
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(f.scope.canCleanupSession()).toBe(false);
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

it("retains descriptorless recovery after failed descriptor publication", async () => {
  const f = fixture();
  const completion = f.register();
  const failure = new SubagentRegistryWriteError("not-committed", new Error("descriptor rejected"));
  const rejected = expect(completion).rejects.toBe(failure);
  f.writes[0]!.gate.resolve();
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  f.writes[1]!.gate.reject(failure);
  await rejected;
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
      expect(f.writes[4]!.snapshot.get(original.runId)).toMatchObject({
        execution: { status: "queued", suppressSessionEffects: true },
        queuedLaunch: undefined,
      });
      f.writes[4]!.assertCurrent();
      const terminalWrite = f.nextWrite;
      f.writes[4]!.gate.resolve();
      const terminal = await terminalWrite;
      expect(f.writes).toHaveLength(6);
      expect(terminal.snapshot.get(original.runId)?.execution).toEqual(
        f.writes[3]!.snapshot.get(original.runId)?.execution,
      );
      expect(original.execution.status).toBe("queued");
      terminal.assertCurrent();
      terminal.gate.resolve();
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

const queuedRegistrationFixtureParams = {
  fixture,
};
registerQueuedRegistrationAdmissionCases(queuedRegistrationFixtureParams);
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
    const completion = work.track(() => f.register());
    const rejection = expect(completion).rejects.toThrow();
    const claimed = f.runs.get(f.registration.runId)!;
    expect(
      f.manager.claimSubagentRunKill({ runId: claimed.runId, expected: claimed }),
    ).toBeDefined();
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
