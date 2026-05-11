import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, withEnv } from "../test-utils/env.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  __testing,
  addSubagentRunForTests,
  clearSubagentRunSteerRestart,
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionRows,
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromState,
  normalizeSubagentRunRecordsSnapshot,
  saveSubagentRegistryToState,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryPersistenceTestDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("subagent registry persistence", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      abortedLastRun: params.abortedLastRun,
      defaultSessionId: `sess-${agentId}-${Date.now()}`,
    });
  };

  const removeChildSessionEntry = async (sessionKey: string) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    return await removeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey,
    });
  };

  const seedChildSessionsForPersistedRuns = async (persisted: Record<string, unknown>) => {
    const runs = (persisted.runs ?? {}) as Record<
      string,
      {
        runId?: string;
        childSessionKey?: string;
      }
    >;
    for (const [runId, run] of Object.entries(runs)) {
      const childSessionKey = run?.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      await writeChildSessionEntry({
        sessionKey: childSessionKey,
        sessionId: `sess-${run.runId ?? runId}`,
      });
    }
  };

  const writePersistedRegistry = async (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    if (opts?.seedChildSessions !== false) {
      await seedChildSessionsForPersistedRuns(persisted);
    }
    const runsRaw = (persisted.runs ?? {}) as Record<string, unknown>;
    saveSubagentRegistryToState(
      normalizeSubagentRunRecordsSnapshot({
        runsRaw,
        isLegacy: persisted.version === 1,
      }),
    );
  };

  const readPersistedRun = async <T>(runId: string): Promise<T | undefined> => {
    return loadSubagentRegistryFromState().get(runId) as T | undefined;
  };

  const createPersistedEndedRun = (params: {
    runId: string;
    childSessionKey: string;
    task: string;
    cleanup: "keep" | "delete";
  }) => {
    const now = Date.now();
    return {
      version: 2,
      runs: {
        [params.runId]: {
          runId: params.runId,
          childSessionKey: params.childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: params.task,
          cleanup: params.cleanup,
          createdAt: now - 2,
          startedAt: now - 1,
          endedAt: now,
        },
      },
    };
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForRegistryWork = async (predicate: () => boolean | Promise<boolean>) => {
    await vi.waitFor(async () => expect(await predicate()).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  };

  const restartRegistry = () => {
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
  };

  const fastPersistSubagentRunsToState = (runs: Map<string, SubagentRunRecord>) => {
    saveSubagentRegistryToState(runs);
  };

  beforeEach(() => {
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
    __testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToState: fastPersistSubagentRunsToState,
      runSubagentAnnounceFlow: announceSpy,
    });
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    __testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists completed subagent timing into the child session entry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;

    const agentId = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming({
      runId: "run-session-timing",
      childSessionKey: "agent:main:subagent:timing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist timing",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      sessionStartedAt: startedAt,
      accumulatedRuntimeMs: 0,
      endedAt,
      outcome: { status: "ok" },
    } as never);

    const store = await readSubagentSessionRows(agentId);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("skips cleanup when cleanupHandled was persisted", async () => {
    const persisted = {
      version: 2,
      runs: {
        "run-2": {
          runId: "run-2",
          childSessionKey: "agent:main:subagent:two",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do the other thing",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          cleanupHandled: true, // Already handled - should be skipped
        },
      },
    };
    await writePersistedRegistry(persisted);
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:two",
      sessionId: "sess-two",
    });

    restartRegistry();
    await flushQueuedRegistryWork();

    // announce should NOT be called since cleanupHandled was true
    const calls = (announceSpy.mock.calls as unknown as Array<[unknown]>).map((call) => call[0]);
    expect(
      calls.some(
        (call) =>
          (call as { childSessionKey?: unknown } | undefined)?.childSessionKey ===
          "agent:main:subagent:two",
      ),
    ).toBe(false);
  });

  it("maps legacy announce fields into cleanup state", async () => {
    const persisted = {
      version: 1,
      runs: {
        "run-legacy": {
          runId: "run-legacy",
          childSessionKey: "agent:main:subagent:legacy",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "legacy announce",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          announceCompletedAt: 9,
          announceHandled: true,
          requesterChannel: "whatsapp",
          requesterAccountId: "legacy-account",
        },
      },
    };
    await writePersistedRegistry(persisted);

    const runs = loadSubagentRegistryFromState();
    const entry = runs.get("run-legacy");
    expect(entry?.cleanupHandled).toBe(true);
    expect(entry?.cleanupCompletedAt).toBe(9);
    expect(entry?.requesterOrigin?.channel).toBe("whatsapp");
    expect(entry?.requesterOrigin?.accountId).toBe("legacy-account");

    expect(loadSubagentRegistryFromState().get("run-legacy")).toMatchObject({
      cleanupHandled: true,
      cleanupCompletedAt: 9,
    });
  });

  it("restores persisted runs from SQLite", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const record: SubagentRunRecord = {
      runId: "run-sqlite",
      childSessionKey: "agent:main:subagent:sqlite",
      requesterSessionKey: "agent:main:main",
      controllerSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sqlite primary subagent registry",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
      spawnMode: "run",
    };

    saveSubagentRegistryToState(new Map([[record.runId, record]]));

    expect(loadSubagentRegistryFromState().get("run-sqlite")).toMatchObject({
      runId: "run-sqlite",
      childSessionKey: "agent:main:subagent:sqlite",
      requesterSessionKey: "agent:main:main",
      spawnMode: "run",
    });
  });

  it("restores taskName from the typed SQLite column", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const record: SubagentRunRecord = {
      runId: "run-sqlite-task-name",
      childSessionKey: "agent:main:subagent:sqlite-task-name",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "typed task name recovery",
      taskName: "typed_recovery",
      cleanup: "keep",
      createdAt: 1,
      spawnMode: "run",
    };

    saveSubagentRegistryToState(new Map([[record.runId, record]]));
    const stateDatabase = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<SubagentRegistryPersistenceTestDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("subagent_runs")
        .set({ payload_json: "{}" })
        .where("run_id", "=", record.runId),
    );

    expect(loadSubagentRegistryFromState().get(record.runId)).toMatchObject({
      runId: record.runId,
      taskName: "typed_recovery",
    });
  });

  it("returns isolated clones for unchanged persisted registry snapshots", async () => {
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-cached": {
            runId: "run-cached",
            childSessionKey: "agent:main:subagent:cached",
            requesterSessionKey: "agent:main:main",
            requesterOrigin: { channel: "telegram", accountId: "cached-account" },
            requesterDisplayKey: "main",
            task: "cached persisted run",
            cleanup: "keep",
            createdAt: 1,
            startedAt: 1,
            outcome: { status: "ok" },
          },
        },
      },
      { seedChildSessions: false },
    );
    const first = loadSubagentRegistryFromState();
    first.clear();
    const cachedEntry = loadSubagentRegistryFromState().get("run-cached");
    if (!cachedEntry) {
      throw new Error("expected cached run");
    }
    cachedEntry.endedAt = 999;
    cachedEntry.cleanupHandled = true;
    if (cachedEntry.requesterOrigin) {
      cachedEntry.requesterOrigin.accountId = "mutated-account";
    }
    if (cachedEntry.outcome) {
      cachedEntry.outcome.status = "error";
    }
    const second = loadSubagentRegistryFromState();

    expectFields(second.get("run-cached")?.requesterOrigin, { accountId: "cached-account" });
    expectFields(second.get("run-cached")?.outcome, { status: "ok" });
    expect(second.get("run-cached")?.endedAt).toBeUndefined();
    expect(second.get("run-cached")?.cleanupHandled).toBeUndefined();

    saveSubagentRegistryToState(
      new Map([
        [
          "run-updated",
          {
            runId: "run-updated",
            childSessionKey: "agent:main:subagent:updated",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "updated persisted run with a longer payload",
            cleanup: "keep",
            createdAt: 2,
            startedAt: 2,
          },
        ],
      ]),
    );

    expect(loadSubagentRegistryFromState().has("run-updated")).toBe(true);
  });

  it("normalizes persisted and newly registered session keys to canonical trimmed values", async () => {
    const persisted = {
      version: 2,
      runs: {
        "run-spaced": {
          runId: "run-spaced",
          childSessionKey: " agent:main:subagent:spaced-child ",
          controllerSessionKey: " agent:main:subagent:controller ",
          requesterSessionKey: " agent:main:main ",
          requesterDisplayKey: "main",
          task: "spaced persisted keys",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
        },
      },
    };
    await writePersistedRegistry(persisted, { seedChildSessions: false });

    const restored = loadSubagentRegistryFromState();
    const restoredEntry = restored.get("run-spaced");
    expectFields(restoredEntry, {
      childSessionKey: "agent:main:subagent:spaced-child",
      controllerSessionKey: "agent:main:subagent:controller",
      requesterSessionKey: "agent:main:main",
    });

    resetSubagentRegistryForTests({ persist: false });
    addSubagentRunForTests(restoredEntry as never);
    const restoredRuns = listSubagentRunsForRequester("agent:main:main");
    expect(restoredRuns).toHaveLength(1);
    expectFields(restoredRuns[0], { runId: "run-spaced" });
    expectFields(getSubagentRunByChildSessionKey("agent:main:subagent:spaced-child"), {
      runId: "run-spaced",
    });

    resetSubagentRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    vi.mocked(callGateway).mockResolvedValueOnce({
      status: "pending",
    });

    registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      controllerSessionKey: " agent:main:subagent:live-controller ",
      requesterSessionKey: " agent:main:main ",
      requesterDisplayKey: "main",
      task: "live spaced keys",
      cleanup: "keep",
    });

    const liveRuns = listSubagentRunsForRequester("agent:main:main");
    expect(liveRuns).toHaveLength(1);
    expectFields(liveRuns[0], {
      runId: "run-live",
      childSessionKey: "agent:main:subagent:live-child",
      controllerSessionKey: "agent:main:subagent:live-controller",
      requesterSessionKey: "agent:main:main",
    });
    expectFields(getSubagentRunByChildSessionKey("agent:main:subagent:live-child"), {
      runId: "run-live",
    });
  });

  it("retries cleanup announce after a failed announce", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-3",
      childSessionKey: "agent:main:subagent:three",
      task: "retry announce",
      cleanup: "keep",
    });
    await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>("run-3");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{
      cleanupHandled?: boolean;
      cleanupCompletedAt?: number;
    }>("run-3");
    expect(afterFirst?.cleanupHandled).toBe(false);
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    const beforeRetry = Date.now();
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>("run-3");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = await readPersistedRun<{ cleanupCompletedAt?: number }>("run-3");
    expect(afterSecond?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
  });

  it("retries cleanup announce after announce flow rejects", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-reject",
      childSessionKey: "agent:main:subagent:reject",
      task: "reject announce",
      cleanup: "keep",
    });
    await writePersistedRegistry(persisted);

    announceSpy.mockRejectedValueOnce(new Error("announce boom"));
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>("run-reject");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{
      cleanupHandled?: boolean;
      cleanupCompletedAt?: number;
    }>("run-reject");
    expect(afterFirst?.cleanupHandled).toBe(false);
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    const beforeRetry = Date.now();
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>("run-reject");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = await readPersistedRun<{ cleanupCompletedAt?: number }>("run-reject");
    expect(afterSecond?.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeRetry);
  });

  it("keeps delete-mode runs retryable when announce is deferred", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-4",
      childSessionKey: "agent:main:subagent:four",
      task: "deferred announce",
      cleanup: "delete",
    });
    await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>("run-4");
      return announceSpy.mock.calls.length === 1 && afterFirst?.cleanupHandled === false;
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>("run-4");
    expect(afterFirst?.cleanupHandled).toBe(false);

    announceSpy.mockResolvedValueOnce(true);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun("run-4");
      return announceSpy.mock.calls.length === 2 && afterSecond === undefined;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    await expect(readPersistedRun("run-4")).resolves.toBeUndefined();
  });

  it("reconciles orphaned restored runs by pruning them from registry", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-restore",
      childSessionKey: "agent:main:subagent:ghost-restore",
      task: "orphan restore",
      cleanup: "keep",
    });
    await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      return (await readPersistedRun("run-orphan-restore")) === undefined;
    });

    expect(announceSpy).not.toHaveBeenCalled();
    await expect(readPersistedRun("run-orphan-restore")).resolves.toBeUndefined();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("reconciles stale unended restored runs that are not restart-recoverable", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      return (await readPersistedRun(runId)) === undefined;
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps stale unended restored runs with abortedLastRun for restart recovery", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      expectFields(request, {
        method: "agent.wait",
      });
      expectFields((request as { params?: unknown }).params, {
        runId: "run-stale-aborted-restore",
      });
      return {
        status: "pending",
      };
    });
    const now = Date.now();
    const runId = "run-stale-aborted-restore";
    const childSessionKey = "agent:main:subagent:stale-aborted-restore";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          [runId]: {
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "stale restart-recoverable work",
            cleanup: "keep",
            createdAt: now - 3 * 60 * 60 * 1_000,
            startedAt: now - 3 * 60 * 60 * 1_000,
          },
        },
      },
      { seedChildSessions: false },
    );
    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted-restore",
      updatedAt: now,
      abortedLastRun: true,
    });

    restartRegistry();
    await waitForRegistryWork(() => vi.mocked(callGateway).mock.calls.length > 0);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(callGateway).mock.calls.at(0) ?? [];
    expectFields(request, { method: "agent.wait" });
    expectFields((request as { params?: unknown } | undefined)?.params, { runId });
    expect(
      listSubagentRunsForRequester("agent:main:main").some((entry) => entry.runId === runId),
    ).toBe(true);
  });

  it("prefers active runs and can resolve them from persisted registry snapshots", async () => {
    const childSessionKey = "agent:main:subagent:state-active";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-complete": {
            runId: "run-complete",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed first",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-active": {
            runId: "run-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "still running",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_STATE: "1" }, () =>
      getSubagentRunByChildSessionKey(childSessionKey),
    );

    expectFields(resolved, {
      runId: "run-active",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBeUndefined();
  });

  it("can resolve the newest child-session row even when an older stale row is still active", async () => {
    const childSessionKey = "agent:main:subagent:state-latest";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-current-ended": {
            runId: "run-current-ended",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed latest",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-stale-active": {
            runId: "run-stale-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "stale active",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_STATE: "1" }, () =>
      getLatestSubagentRunByChildSessionKey(childSessionKey),
    );

    expectFields(resolved, {
      runId: "run-current-ended",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBe(220);
  });

  it("resume guard prunes orphan runs before announce retry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const runId = "run-orphan-resume-guard";
    const childSessionKey = "agent:main:subagent:ghost-resume";
    const now = Date.now();

    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume orphan guard",
      cleanup: "keep",
      createdAt: now - 50,
      startedAt: now - 25,
      endedAt: now,
      suppressAnnounceReason: "steer-restart",
      cleanupHandled: false,
    });
    await removeChildSessionEntry(childSessionKey);

    const changed = clearSubagentRunSteerRestart(runId);
    expect(changed).toBe(true);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    const persisted = loadSubagentRegistryFromState();
    expect(persisted.has(runId)).toBe(false);
  });
});
