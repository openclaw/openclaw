import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  configureMockSubagentRegistryPersistence,
  createSubagentRunRecord,
  type MockSubagentRegistryRows,
} from "../../subagent-test-fixtures.test-helpers.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionStore = vi.hoisted((): Record<string, SessionEntry> => ({
  "agent:main:subagent:child": { sessionId: "sess-child", updatedAt: 1 },
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../config/sessions/session-entry-read-runtime.js")
  >()),
  readSessionEntryReadOnlyInWorker: vi.fn<
    typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryReadOnlyInWorker
  >(async (scope, assertCurrent) => {
    assertCurrent?.();
    const entry = await Promise.resolve(sessionStore[scope.sessionKey]);
    assertCurrent?.();
    return entry;
  }),
}));

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  })),
  updateSessionStore: vi.fn(),
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  onAgentEventStop: vi.fn(),
  onAgentEvent: vi.fn(),
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue("retryable"),
  captureSubagentCompletionReply: vi.fn(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(() => new Map()),
  persistRegistryRows: vi.fn<MockSubagentRegistryRows>(),
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: () => sessionStore,
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveSessionStorePathCore: () => "/tmp/test-store",
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => {
  const listSessionEntriesCore = () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  const loadSessionEntry = (scope: { sessionKey: keyof typeof sessionStore }) =>
    sessionStore[scope.sessionKey];
  return {
    findTranscriptEvent: vi.fn(async () => undefined),
    listSessionEntriesCore,
    listSessionEntriesReadOnly: listSessionEntriesCore,
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
    patchSessionEntryCore: async () => null,
  };
});

vi.mock("../../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: mocks.onAgentEvent,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

// mock-isolation: Keep loop timing independent of native snapshots and worker startup.
vi.mock("../../../state/openclaw-state-db-readonly.js", () => ({
  getActiveOpenClawStateDatabaseReadSnapshot: () => undefined,
  executeExistingOpenClawStateRead: vi.fn<
    typeof import("../../../state/openclaw-state-db-readonly.js").executeExistingOpenClawStateRead
  >(async (_options, command, options) => {
    expect(command).toEqual({ type: "subagents.restore" });
    const runs = mocks.loadSubagentRegistryFromSqlite();
    options?.onChunk?.(
      [...runs.values()].map((entry) => ({
        entry,
        createdAt: entry.createdAt,
      })),
    );
    return { ok: true, type: "subagents.restore", sourceAdmitted: true, count: runs.size };
  }),
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce.js")>()),
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));
vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

let registry: typeof import("./subagent-registry.test-helpers.js");

const makeEntry = (endedAgo: number, overrides: Partial<SubagentRunRecord> = {}) =>
  createSubagentRunRecord({
    runId: "test-run",
    childSessionIdentity: { sessionId: "sess-child" },
    requesterDisplayKey: "agent:main:main",
    createdAt: Date.now() - endedAgo,
    execution: { status: "terminal", endedAt: Date.now() - endedAgo },
    ...overrides,
  });

async function hydrateAndActivateRegistry(entry: SubagentRunRecord, recover = true) {
  mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));
  if (recover) {
    await prepareSubagentRecoveryFixture(entry, { entries: sessionStore });
  }
  await registry.initSubagentRegistry();
  const recoveryRuntime = {
    prepareRestartRecovery: () => undefined,
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(async () => ({ status: "pending" })),
    sendRecoveryNotice: vi.fn(),
  };
  const gatewayContext = {
    recoveryRuntime,
    resolveGatewayContext: () => gatewayContext as never,
  };
  await registry.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
}

const { flushAsync, waitForRun } = createLifecycleWaits("agent:main:main");

beforeAll(async () => {
  registry = await import("./subagent-registry.test-helpers.js");
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.loadSubagentRegistryFromSqlite.mockReset().mockReturnValue(new Map());
  mocks.onAgentEvent.mockReset().mockReturnValue(mocks.onAgentEventStop);
  mocks.runSubagentAnnounceFlow.mockReset().mockResolvedValue("retryable");
  await registry.resetSubagentRegistryForTests({ persist: false });
  mocks.persistRegistryRows.mockReset();
  await configureMockSubagentRegistryPersistence(mocks);
});

afterEach(async () => {
  try {
    await flushAsync();
  } finally {
    await registry.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
  const now = Date.now();
  const entry = makeEntry(10 * 60_000, {
    delivery: { status: "pending", attemptCount: 3, lastAttemptAt: now - 9 * 60_000 },
  });

  const beforeInit = Date.now();
  await hydrateAndActivateRegistry(entry, false);
  const completed = await waitForRun(
    entry.runId,
    (run) => typeof run.cleanupCompletedAt === "number",
  );

  expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  expect(completed.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeInit);
  expect(mocks.persistRegistryRows).toHaveBeenCalledWith(expect.any(Map), [entry.runId]);
});

test.each([0, 1_000])(
  "preserves requester budget through restored backoff (%d ms)",
  async (restoreDelayMs) => {
    const attemptCount = 3;
    mocks.runSubagentAnnounceFlow.mockResolvedValue("requester_turn_pending");

    const now = Date.now();
    const entry = makeEntry(60_000, {
      expectsCompletionMessage: true,
      delivery: {
        status: "pending",
        attemptCount: 3,
        lastAttemptAt: now - 30_000,
        ...(restoreDelayMs ? { nextAttemptAt: now + restoreDelayMs } : {}),
      },
    });

    await hydrateAndActivateRegistry(entry);
    if (restoreDelayMs) {
      await registry.initSubagentRegistry();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(restoreDelayMs);
    }
    const resumed = await waitForRun(
      entry.runId,
      (run) =>
        run.delivery?.attemptCount === attemptCount &&
        typeof run.delivery.nextAttemptAt === "number",
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(resumed.cleanupCompletedAt).toBeUndefined();
    expect(resumed.delivery).toMatchObject({
      status: "pending",
      attemptCount,
      windowStartedAt: entry.execution.endedAt,
      deadlineAt: entry.execution.endedAt! + 30 * 60_000,
    });
    expect(resumed.delivery!.nextAttemptAt).toBeGreaterThan(now);
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    await vi.advanceTimersByTimeAsync(resumed.delivery!.nextAttemptAt! - Date.now());
    const retried = await waitForRun(entry.runId, (run) => run.delivery?.attemptCount === 4);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
    expect(retried.delivery?.deadlineAt).toBe(entry.execution.endedAt! + 30 * 60_000);
  },
);

test("announce rejection resets cleanupHandled so retries can resume", async () => {
  mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));

  const entry = makeEntry(10_000, { cleanupHandled: false });
  await hydrateAndActivateRegistry(entry);
  await flushAsync();

  const stored = await waitForRun(
    entry.runId,
    (run) => run.cleanupHandled === false && run.delivery?.attemptCount === 1,
  );
  expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
  expect(stored.cleanupCompletedAt).toBeUndefined();
  expect(stored.delivery?.lastAttemptAt).toBeTypeOf("number");
});
