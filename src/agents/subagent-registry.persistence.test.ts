import { afterEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { saveSessionEntriesToDb } from "../config/sessions/store-sqlite.js";
import {
  saveSubagentRunToDb,
  loadAllSubagentRunsFromDb,
  loadSubagentRunFromDb,
} from "./subagent-registry-sqlite.js";
import {
  addSubagentRunForTests,
  clearSubagentRunSteerRestart,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { loadSubagentRegistryFromDisk } from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { useSubagentRegistryTestDb } from "./test-helpers.subagent-registry.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

describe("subagent registry persistence", () => {
  useSubagentRegistryTestDb();

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  /** Insert a child session entry into the test SQLite DB. */
  const writeChildSessionEntry = (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const entry = {
      sessionId: params.sessionId ?? `sess-${agentId}-${Date.now()}`,
      updatedAt: params.updatedAt ?? Date.now(),
    };
    saveSessionEntriesToDb(agentId, { [params.sessionKey]: entry as never });
  };

  /** Remove a child session entry from the test SQLite DB. */
  const removeChildSessionEntry = (sessionKey: string) => {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    // Save empty store to clear entries for this agent
    saveSessionEntriesToDb(agentId, {});
  };

  /** Seed a persisted run into SQLite and ensure child session exists. */
  const seedPersistedRun = (run: SubagentRunRecord) => {
    saveSubagentRunToDb(run);
    writeChildSessionEntry({
      sessionKey: run.childSessionKey,
      sessionId: `sess-${run.runId}`,
    });
  };

  const createEndedRun = (params: {
    runId: string;
    childSessionKey: string;
    task: string;
    cleanup: "keep" | "delete";
  }): SubagentRunRecord => {
    const now = Date.now();
    return {
      runId: params.runId,
      childSessionKey: params.childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: params.task,
      cleanup: params.cleanup,
      createdAt: now - 2,
      startedAt: now - 1,
      endedAt: now,
    };
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const restartRegistryAndFlush = async () => {
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();
  };

  afterEach(() => {
    announceSpy.mockClear();
    resetSubagentRegistryForTests({ persist: false });
  });

  it("persists runs to database and resumes after restart", async () => {
    registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-main " },
      requesterDisplayKey: "main",
      task: "do the thing",
      cleanup: "keep",
    });
    writeChildSessionEntry({
      sessionKey: "agent:main:subagent:test",
      sessionId: "sess-test",
    });

    // Verify persisted to SQLite
    const persisted = loadAllSubagentRunsFromDb();
    expect([...persisted.keys()]).toContain("run-1");
    const run = persisted.get("run-1");
    expect(run?.requesterOrigin?.channel).toBe("whatsapp");
    expect(run?.requesterOrigin?.accountId).toBe("acct-main");

    // Simulate a process restart
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    expect(announceSpy).toHaveBeenCalled();

    type AnnounceParams = {
      childSessionKey: string;
      childRunId: string;
      requesterSessionKey: string;
      requesterOrigin?: { channel?: string; accountId?: string };
      task: string;
      cleanup: string;
      label?: string;
    };
    const first = (announceSpy.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
      | AnnounceParams
      | undefined;
    if (!first) {
      throw new Error("expected announce call");
    }
    expect(first.childSessionKey).toBe("agent:main:subagent:test");
    expect(first.requesterOrigin?.channel).toBe("whatsapp");
    expect(first.requesterOrigin?.accountId).toBe("acct-main");
  });

  it("skips cleanup when cleanupHandled was persisted", async () => {
    saveSubagentRunToDb({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:two",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do the other thing",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      cleanupHandled: true,
    });
    writeChildSessionEntry({
      sessionKey: "agent:main:subagent:two",
      sessionId: "sess-two",
    });

    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    const calls = (announceSpy.mock.calls as unknown as Array<[unknown]>).map((call) => call[0]);
    const match = calls.find(
      (params) =>
        (params as { childSessionKey?: string }).childSessionKey === "agent:main:subagent:two",
    );
    expect(match).toBeFalsy();
  });

  it("retries cleanup announce after a failed announce", async () => {
    const run = createEndedRun({
      runId: "run-3",
      childSessionKey: "agent:main:subagent:three",
      task: "retry announce",
      cleanup: "keep",
    });
    seedPersistedRun(run);

    announceSpy.mockResolvedValueOnce(false);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = loadSubagentRunFromDb("run-3");
    expect(afterFirst?.cleanupHandled).toBeFalsy();
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = loadSubagentRunFromDb("run-3");
    expect(afterSecond?.cleanupCompletedAt).toBeDefined();
  });

  it("retries cleanup announce after announce flow rejects", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-reject",
      childSessionKey: "agent:main:subagent:reject",
      task: "reject announce",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockRejectedValueOnce(new Error("announce boom"));
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupHandled?: boolean; cleanupCompletedAt?: number }>;
    };
    expect(afterFirst.runs["run-reject"].cleanupHandled).toBe(false);
    expect(afterFirst.runs["run-reject"].cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-reject"].cleanupCompletedAt).toBeDefined();
  });

  it("keeps delete-mode runs retryable when announce is deferred", async () => {
    const run = createEndedRun({
      runId: "run-4",
      childSessionKey: "agent:main:subagent:four",
      task: "deferred announce",
      cleanup: "delete",
    });
    seedPersistedRun(run);

    announceSpy.mockResolvedValueOnce(false);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = loadSubagentRunFromDb("run-4");
    expect(afterFirst?.cleanupHandled).toBeFalsy();

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = loadSubagentRunFromDb("run-4");
    expect(afterSecond).toBeNull();
  });

  it("reconciles orphaned restored runs by pruning them from registry", async () => {
    const run = createEndedRun({
      runId: "run-orphan-restore",
      childSessionKey: "agent:main:subagent:ghost-restore",
      task: "orphan restore",
      cleanup: "keep",
    });
    // Seed into DB but do NOT create child session (orphan)
    saveSubagentRunToDb(run);

    await restartRegistryAndFlush();

    expect(announceSpy).not.toHaveBeenCalled();
    const afterRun = loadSubagentRunFromDb("run-orphan-restore");
    expect(afterRun).toBeNull();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("resume guard prunes orphan runs before announce retry", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:ghost-resume";

    writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    addSubagentRunForTests({
      runId: "run-orphan-resume-guard",
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
    removeChildSessionEntry(childSessionKey);

    const changed = clearSubagentRunSteerRestart("run-orphan-resume-guard");
    expect(changed).toBe(true);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    const persisted = loadSubagentRegistryFromDisk();
    expect(persisted.has("run-orphan-resume-guard")).toBe(false);
  });
});
