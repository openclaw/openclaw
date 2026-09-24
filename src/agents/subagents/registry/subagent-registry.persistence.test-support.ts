/**
 * Test helpers for subagent registry persistence scenarios. They seed minimal
 * SQLite-backed session entries and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import type { captureTaskDeliveryWork } from "../../../tasks/task-registry-delivery.test-support.js";
import { captureTaskRegistryReadFence } from "../../../tasks/task-registry-listener-state.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SessionStore = Record<string, Record<string, unknown>>;

export function expectDeferredSubagentAnnouncement(
  entry: SubagentRunRecord | undefined,
  runId: string,
) {
  expect(entry, "deferred announcement committed").toMatchObject({
    cleanupHandled: false,
    delivery: { status: "pending", attemptCount: 1, payload: { childRunId: runId } },
  });
  expect(entry?.cleanupCompletedAt, "deferred cleanup remains unfinished").toBeUndefined();
  expect(Number.isFinite(entry?.delivery?.nextAttemptAt), "durable retry deadline").toBe(true);
}

/** Hold the real lazy settlement dependency without replacing its completion policy. */
export function gateSubagentRequesterSettlement(
  settle: typeof maybeWakeRequesterAfterAllChildrenSettled,
) {
  const released = createDeferred();
  let pending: Promise<boolean> | undefined;
  const run = vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>((params) => {
    pending = (async () => {
      await released.promise;
      return await settle(params);
    })();
    return pending;
  });
  return {
    run,
    async release() {
      released.resolve();
      await pending;
    },
  };
}

/** Gates owned by a test must be released before waiting for imports and detached tails. */
export async function settleSubagentRegistryPersistenceWork(
  deliveries?: ReturnType<typeof captureTaskDeliveryWork>,
) {
  await vi.dynamicImportSettled();
  // Accepted task events can outlive both reset and synchronous task reads.
  const failures: unknown[] = [];
  try {
    await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
  } catch (error) {
    failures.push(error);
  }
  // A committed event can publish delivery even when its own cleanup failed.
  try {
    await deliveries?.settle();
  } catch (error) {
    failures.push(error);
  }
  // Terminal notification writes run off the Gateway thread, so uncaptured
  // deliveries can outlive the default fence on a loaded runner.
  try {
    await vi.waitFor(
      () => {
        const holders = getActiveGatewayRootWorkHolders();
        expect(
          getActiveGatewayRootWorkCount(),
          `residual registry roots: ${holders.join(", ") || "unattributed"}`,
        ).toBe(0);
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Subagent registry fixture work failed");
  }
}

type PersistenceCleanup = {
  stateDir: string;
  resetRegistry: () => void;
  closeDatabases?: () => void | Promise<void>;
};

export async function cleanupSubagentRegistryPersistenceTest(params: PersistenceCleanup) {
  await settleSubagentRegistryPersistenceWork();
  params.resetRegistry();
  await cleanupSessionStateForTest({ stateDir: params.stateDir });
  await params.closeDatabases?.();
  await fs.rm(params.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Finish fixture-owned writes before withEnvAsync restores their database location. */
export async function withSubagentRegistryPersistenceState<T>(
  params: PersistenceCleanup,
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: params.stateDir }, async () => {
    try {
      return await run();
    } finally {
      await cleanupSubagentRegistryPersistenceTest(params);
    }
  });
}

export type SubagentRunFixture = Omit<SubagentRunRecord, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};

function resolveSubagentSessionStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

/** Expands shorthand test records into the canonical nested persistence shape. */
export function createCanonicalSubagentRunFixture(run: SubagentRunFixture): SubagentRunRecord {
  const { startedAt, endedAt, outcome, ...record } = run;
  const terminal = typeof endedAt === "number";
  return {
    ...record,
    execution:
      run.execution ??
      (terminal
        ? { status: "terminal", startedAt, endedAt, outcome }
        : { status: "running", startedAt }),
    completion: run.completion ?? { required: run.expectsCompletionMessage === true },
    delivery: run.delivery ?? {
      status:
        run.expectsCompletionMessage === false
          ? "not_required"
          : terminal
            ? "pending"
            : "not_required",
    },
  };
}

export function canonicalSubagentRunFixtures(
  runs: ReadonlyMap<string, SubagentRunFixture>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, run]) => [runId, createCanonicalSubagentRunFixture(run)]));
}

/** Reads test session entries through the active SQLite accessor. */
export async function readSubagentSessionStore(storePath: string): Promise<SessionStore> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  ) as unknown as SessionStore;
}

/** Writes or updates one SQLite-backed subagent session entry for persistence tests. */
export async function writeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  sessionId?: string;
  updatedAt?: number;
  abortedLastRun?: boolean;
  lifecycleRevision?: string;
  agentId: string;
  defaultSessionId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  const current = loadSessionEntry({ storePath, sessionKey: params.sessionKey });
  const entry: SessionEntry = {
    ...current,
    sessionId: params.sessionId ?? params.defaultSessionId,
    updatedAt: params.updatedAt ?? Date.now(),
    ...(typeof params.abortedLastRun === "boolean"
      ? { abortedLastRun: params.abortedLastRun }
      : {}),
    ...(params.lifecycleRevision ? { lifecycleRevision: params.lifecycleRevision } : {}),
  };
  await replaceSessionEntry({ storePath, sessionKey: params.sessionKey }, entry);
  return storePath;
}

/** Removes one SQLite-backed subagent session entry for persistence tests. */
export async function removeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  agentId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  await applySessionEntryLifecycleMutation({
    storePath,
    removals: [{ sessionKey: params.sessionKey }],
    skipMaintenance: true,
  });
  return storePath;
}

export function createDeliveredWake(
  runId: string,
  requesterSettleWake?: NonNullable<SubagentRunRecord["requesterSettleWake"]>,
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  const endedAt = overrides.endedAt ?? Date.now();
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    endedAt,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "done", capturedAt: endedAt },
    delivery: { status: "delivered", deliveredAt: endedAt },
    cleanupHandled: true,
    cleanupCompletedAt: endedAt,
    requesterSettleWake,
    ...overrides,
  });
}

export function writeChildSession(
  stateDir: string,
  sessionKey: string,
  defaultSessionId: string,
  lifecycleRevision?: string,
) {
  return writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId,
    lifecycleRevision,
  });
}

export function createOrphanedRequiredDelivery(
  status: "pending" | "suspended" | "in_progress",
): SubagentRunRecord {
  const now = Date.now();
  const runId = `run-orphan-${status}-delivery`;
  const childSessionKey = `agent:main:subagent:orphan-${status}-delivery`;
  const terminalReply = { disposition: "visible" as const, text: "durable final reply" };
  return createSubagentRunRecord({
    runId,
    childSessionKey,
    task: "deliver after restart",
    cleanup: "delete",
    createdAt: now - 100,
    expectsCompletionMessage: true,
    cleanupHandled: false,
    startedAt: now - 50,
    endedAt: now,
    outcome: { status: "ok" },
    completion: {
      required: true,
      resultText: "canonical final reply",
      capturedAt: now,
      terminalReply,
    },
    delivery: {
      status,
      ...(status === "suspended" ? { suspendedAt: now, suspendedReason: "expiry" as const } : {}),
      ...(status === "in_progress"
        ? { disposition: "session_queued" as const, queueId: "queue-1" }
        : {}),
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey,
        childRunId: runId,
        task: "deliver after restart",
        startedAt: now - 50,
        endedAt: now,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        terminalReply,
      },
    },
  });
}

export function registerSubagentRegistrationPersistenceTests({
  getRegistry,
  mocks,
  mockPendingAgentWait,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "persistSubagentRunsToDiskOrThrow" | "persistSubagentRunsToDisk"
  >;
  mockPendingAgentWait: () => void;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}) {
  it("throws and removes the entry when the initial durable registry write fails", () => {
    const mod = getRegistry();
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-durability-required",
        task: "must fail closed",
      }),
    ).toThrowError("disk full");

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-durability-required"),
    ).toBeUndefined();
  });

  it.each([
    { name: "running", queued: false },
    { name: "queued", queued: true },
  ])("persists a $name registration exactly once", async ({ queued }) => {
    const mod = getRegistry();
    mockPendingAgentWait();

    const runId = `run-single-persist-${queued ? "queued" : "running"}`;
    const registrationCompletion = mod.registerSubagentRun({
      runId,
      task: "persist one registry snapshot",
      queued,
    });
    if (registrationCompletion) {
      await registrationCompletion;
    }

    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledWith(expect.any(Map), [runId]);
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
  });

  it.each([
    { name: "running", queued: false },
    { name: "queued", queued: true },
  ])("isolates a $name registration from task runtime input mutation", async ({ queued }) => {
    const mod = getRegistry();
    const runId = `run-isolated-origin-${queued ? "queued" : "running"}`;
    const expectedRequesterOrigin = {
      channel: "discord",
      to: "channel:123",
      accountId: "acct-1",
      threadId: 42,
    };
    const requesterOrigin = {
      ...expectedRequesterOrigin,
      deliveryIntent: {
        id: "delivery-1",
        kind: "outbound_queue" as const,
        queuePolicy: "required" as const,
      },
    };
    let persistedEntry: SubagentRunRecord | undefined;
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce((runs) => {
      persistedEntry = structuredClone(runs.get(runId));
    });
    mockPendingAgentWait();
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const mutateRequesterOrigin = (
      taskParams: Parameters<typeof defaultRuntime.createQueuedTaskRun>[0],
    ) => {
      if (!taskParams.requesterOrigin) {
        throw new Error("expected requester origin");
      }
      Object.assign(taskParams.requesterOrigin, {
        channel: "mutated",
        to: "mutated",
        accountId: "mutated",
        threadId: "mutated",
      });
    };
    const createMutatingQueuedTaskRun = vi.fn(
      (taskParams: Parameters<typeof defaultRuntime.createQueuedTaskRun>[0]) => {
        mutateRequesterOrigin(taskParams);
        return defaultRuntime.createQueuedTaskRun(taskParams);
      },
    );
    const createMutatingRunningTaskRun = vi.fn(
      (taskParams: Parameters<typeof defaultRuntime.createRunningTaskRun>[0]) => {
        mutateRequesterOrigin(taskParams);
        return defaultRuntime.createRunningTaskRun(taskParams);
      },
    );
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: createMutatingQueuedTaskRun,
      createRunningTaskRun: createMutatingRunningTaskRun,
    });

    const registrationCompletion = mod.registerSubagentRun({
      runId,
      task: "isolate the registry delivery context",
      queued,
      requesterOrigin,
    });
    if (registrationCompletion) {
      await registrationCompletion;
    }

    expect(
      queued ? createMutatingQueuedTaskRun : createMutatingRunningTaskRun,
    ).toHaveBeenCalledOnce();
    expect(findRequesterRun(runId)?.requesterOrigin).toEqual(expectedRequesterOrigin);
    expect(persistedEntry?.requesterOrigin).toEqual(expectedRequesterOrigin);
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
  });

  const optionalTaskRowFaults: Array<[label: string, createTaskRun: () => null]> = [
    ["returns no row", () => null],
    [
      "throws",
      () => {
        throw new Error("task store unavailable");
      },
    ],
  ];
  it.each(optionalTaskRowFaults)(
    "keeps ACP-style registry ownership when the secondary task runtime %s",
    async (_label, createTaskRun) => {
      const mod = getRegistry();
      const runId = `run-acp-task-fault-${_label.replaceAll(" ", "-")}`;
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        createQueuedTaskRun: createTaskRun,
        createRunningTaskRun: createTaskRun,
      });
      mockPendingAgentWait();

      await mod.registerSubagentRun({
        runId,
        task: "preserve ACP registry ownership",
      });

      expect(findRequesterRun(runId)).toMatchObject({
        runId,
        task: "preserve ACP registry ownership",
      });
    },
  );

  it("keeps memory aligned with the durable registration when rollback persistence fails", async () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:task-row-rollback-failure";
    mod.addSubagentRunForTests({
      runId: "run-task-row-rollback-old",
      childSessionKey,
      task: "preserve the durable predecessor state",
      createdAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: Date.now() - 500 },
    });
    mocks.persistSubagentRunsToDiskOrThrow
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("rollback disk full");
      });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      createRunningTaskRun: () => null,
    });
    const waitStarted = createDeferred<Parameters<typeof mocks.callGateway>[0]>();
    mocks.callGateway.mockImplementation(async (request) => {
      if (request.method === "agent.wait") {
        waitStarted.resolve(request);
      }
      return { status: "pending" };
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-task-row-rollback-new",
        childSessionKey,
        task: "retain the last durable snapshot",
        taskRowOwnership: "required",
      }),
    ).toThrowError("rollback disk full");

    expect(findRequesterRun("run-task-row-rollback-new")).toMatchObject({
      runId: "run-task-row-rollback-new",
      childSessionKey,
    });
    expect(
      findRequesterRun("run-task-row-rollback-old")?.killReconciliation?.supersededAt,
    ).toBeTypeOf("number");
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledTimes(2);
    expect(await waitStarted.promise).toEqual(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-task-row-rollback-new" }),
      }),
    );
  });

  it("restores the source owner when replacement persistence fails", async () => {
    const mod = getRegistry();
    mockPendingAgentWait();
    const registrationCompletion = mod.registerSubagentRun({
      runId: "run-replacement-persist-old",
      childSessionKey: "agent:main:subagent:replacement-persist",
      task: "keep live successor tracked",
    });
    if (registrationCompletion) {
      await registrationCompletion;
    }
    mocks.persistSubagentRunsToDiskOrThrow.mockClear();
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-replacement-persist-old",
        nextRunId: "run-replacement-persist-new",
      }),
    ).toThrow("disk full");

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs).toEqual([
      expect.objectContaining({
        runId: "run-replacement-persist-old",
        taskRunId: "run-replacement-persist-old",
      }),
    ]);
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
  });

  it("rolls back an older kill ownership boundary when registration persistence fails", () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:registration-rollback";
    mod.addSubagentRunForTests({
      runId: "run-registration-rollback-old",
      childSessionKey,
      task: "preserve old ownership",
      createdAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: Date.now() - 500 },
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-registration-rollback-new",
        childSessionKey,
        task: "new generation",
      }),
    ).toThrowError("disk full");

    const oldRun = findRequesterRun("run-registration-rollback-old");
    expect(oldRun?.killReconciliation).toEqual({ killedAt: Date.now() - 500 });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .some((entry) => entry.runId === "run-registration-rollback-new"),
    ).toBe(false);
  });

  it("rolls back a killed tombstone when its durable registry write fails", async () => {
    const mod = getRegistry();
    mockPendingAgentWait();
    const runId = "run-kill-persist-failure";
    const registrationCompletion = mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:kill-persist-failure",
      task: "keep kill state atomic",
    });
    if (registrationCompletion) {
      await registrationCompletion;
    }
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toThrowError(
      "disk full",
    );

    const run = findRequesterRun(runId);
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.endedReason).toBeUndefined();
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "running" });
  });
}
