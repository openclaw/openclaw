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
  const calls = observeSubagentRequesterWake((params) => {
    pending = (async () => {
      await released.promise;
      return await settle(params);
    })();
    return pending;
  });
  return {
    ...calls,
    async release() {
      released.resolve();
      await pending;
    },
  };
}

/** Observe admission after real worker IO without racing a fake-clock polling deadline. */
export function observeSubagentRequesterWake(
  wake: typeof maybeWakeRequesterAfterAllChildrenSettled,
) {
  let calls = 0;
  const admitted = new Map<number, ReturnType<typeof createDeferred<void>>>();
  return {
    run: vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>((params) => {
      admitted.get(++calls)?.resolve();
      return wake(params);
    }),
    waitForCalls(this: void, count: number): Promise<void> {
      if (calls >= count) {
        return Promise.resolve();
      }
      let waiter = admitted.get(count);
      if (!waiter) {
        waiter = createDeferred();
        admitted.set(count, waiter);
      }
      return waiter.promise;
    },
  };
}

/** Gates owned by a test must be released before waiting for imports and detached tails. */
export async function settleSubagentRegistryPersistenceWork(
  settleOwnedWork?: () => void | Promise<void>,
) {
  await vi.dynamicImportSettled();
  await settleOwnedWork?.();
  await vi.waitFor(() => {
    const holders = getActiveGatewayRootWorkHolders();
    expect(
      getActiveGatewayRootWorkCount(),
      `residual registry roots: ${holders.join(", ") || "unattributed"}`,
    ).toBe(0);
  });
}

type PersistenceCleanup = {
  stateDir: string;
  resetRegistry: () => void;
  closeDatabases?: () => void | Promise<void>;
  settleOwnedWork?: () => void | Promise<void>;
};

export async function cleanupSubagentRegistryPersistenceTest(params: PersistenceCleanup) {
  await settleSubagentRegistryPersistenceWork(params.settleOwnedWork);
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
  ])("persists the $name native admission before returning", async ({ queued }) => {
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

    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledTimes(queued ? 2 : 1);
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledWith(expect.any(Map), [runId]);
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
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
  });
}

export function createRestoredRequesterWakeRuns(params: {
  activationSettlement: boolean;
  requesterYielded?: true;
  endedAt: number;
}): SubagentRunRecord[] {
  const { activationSettlement, requesterYielded, endedAt } = params;
  return Array.from({ length: 3 }, (_, index): SubagentRunRecord => {
    const runId = `run-restored-wake-${index}`;
    return createDeliveredWake(
      runId,
      requesterYielded ? undefined : { status: "pending", attemptCount: 0 },
      {
        childSessionKey: `agent:main:subagent:restored-wake-${index}`,
        requesterSessionKey: `agent:main:requester-${index}`,
        requesterDisplayKey: `requester-${index}`,
        task: "resume a durable requester wake",
        createdAt: endedAt - 1_000,
        endedReason: "subagent-complete",
        startedAt: endedAt - 500,
        endedAt,
        ...(activationSettlement
          ? {
              requesterTurnRunId: `requester-turn-${index}`,
              requesterTurnYielded: requesterYielded ?? undefined,
              taskRunId: runId,
            }
          : {}),
      },
    );
  });
}
