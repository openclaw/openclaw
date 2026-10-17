import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import * as memorySessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMemorySessionTombstones,
  recordMemorySessionTombstonesInDatabase,
} from "../memory-session-tombstones.js";
import * as cpuRuntime from "./manager-cpu-worker-runtime.js";
import {
  SessionStartupCatchupHarness as Harness,
  emitSessionTranscriptUpdate,
  startupHarnessDatabases,
  resetTranscriptUpdateListener,
} from "./manager-sync-ops.startup-catchup.test-support.js";

describe("session startup catch-up", () => {
  let stateDir = "";
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-startup-",
      layout: "state-only",
    });
    await captureRuntimeConfigAsyncReader()();
    stateDir = testState.stateDir;
    resetTranscriptUpdateListener();
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptUpdateListener();
    for (const database of startupHarnessDatabases) {
      await database.closeShadow();
    }
    startupHarnessDatabases.clear();
    await testState.restoreEnv();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  async function writeSessionFile(
    name: string,
    content = "startup catchup",
    timestamp?: string,
  ): Promise<{ filePath: string; size: number; mtimeMs: number }> {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, name);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        type: "message",
        ...(timestamp ? { timestamp } : {}),
        message: { role: "user", content },
      }) + "\n",
      "utf-8",
    );
    const stat = await fs.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async function configureTestSessionStore(storePath: string): Promise<void> {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await testState.writeConfig({ session: { store: storePath } });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await captureRuntimeConfigAsyncReader()();
  }

  type TranscriptMessage = {
    role: "user" | "assistant";
    content: string;
    provenance?: { kind: "internal_system"; sourceTool: string };
  };

  async function writeSqliteSession(
    params: {
      storePath?: string;
      sessionId?: string;
      sessionKey?: string;
      content?: string;
      message?: TranscriptMessage;
      updatedAt?: number;
    } = {},
  ) {
    const storePath =
      params.storePath ?? path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionId = params.sessionId ?? "thread";
    const sessionKey = params.sessionKey ?? `agent:main:chat:${sessionId}`;
    const identity = { agentId: "main", sessionId, sessionKey, storePath };
    await configureTestSessionStore(storePath);
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId, updatedAt: params.updatedAt ?? 10 },
    });
    await append(identity, params.message ?? params.content ?? "startup catchup");
    return { storePath, sessionId, sessionKey, corpusPath: `sessions/main/${sessionId}.jsonl` };
  }

  const append = (
    session: { sessionId: string; sessionKey: string; storePath: string },
    content: string | TranscriptMessage,
    role: "user" | "assistant" = "user",
  ) =>
    appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      storePath: session.storePath,
      cwd: stateDir,
      message: typeof content === "string" ? { role, content } : content,
    });

  async function readEntry(...args: Parameters<typeof memorySessions.buildSessionEntry>) {
    const entry = await memorySessions.buildSessionEntry(...args);
    assert.isNotNull(entry, "Expected a transcript entry");
    return entry;
  }

  const sourceRow = (entry: memorySessions.SessionFileEntry, mtime = entry.mtimeMs) => ({
    path: entry.path,
    hash: entry.hash,
    mtime,
    size: entry.size,
  });
  async function flushSessionSync(harness: Harness, ms = 30_000) {
    await vi.advanceTimersByTimeAsync(ms);
    await harness.waitForSessionSync();
  }

  it("defers startup parsing while excluding system-only sessions and catching later user content", async () => {
    const session = await writeSqliteSession({
      sessionId: "cron-base",
      sessionKey: "agent:main:cron:synthetic-job",
      // Keep the synthetic session recent so retention cannot prune it.
      updatedAt: Date.now(),
      message: {
        role: "user",
        content: "Scheduled internal maintenance reminder.",
        provenance: { kind: "internal_system", sourceTool: "cron" },
      },
    });
    const harness = await Harness.create([], true);
    const parse = vi.spyOn(memorySessions, "buildSessionEntry");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await expect(harness.markStartupDirtyFiles(true)).resolves.toEqual([]);
      expect(harness.isSessionsDirty()).toBe(false);
      expect(parse).toHaveBeenCalledOnce();
      parse.mockClear();
      await harness.catchUp();
      expect(parse).not.toHaveBeenCalled();
      expect(harness.indexedPaths).toEqual([]);
      await flushSessionSync(harness);
      expect(harness.indexedPaths).toEqual([]);

      await append(session, "Remember my favorite fruit is mango.");
      await harness.catchUp();
      expect(parse).not.toHaveBeenCalled();
      await flushSessionSync(harness);
      expect(harness.indexedPaths).toEqual([session.corpusPath]);
      expect(harness.indexedContents[0]).toContain("Remember my favorite fruit is mango.");
    } finally {
      parse.mockRestore();
    }
  });

  it("prunes indexed sessions that are absent from the live corpus", async () => {
    const stalePath = "sessions/main/deleted.jsonl";
    const harness = await Harness.create(
      [{ path: stalePath, hash: "stale-hash", mtime: 10, size: 20 }],
      true,
    );

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.syncCalls).toEqual([]);
    await flushSessionSync(harness);

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.deletedSources).toEqual([
      { path: stalePath, source: "sessions", expectedHash: "stale-hash" },
    ]);
    expect(harness.getIndexedSourceState(stalePath)).toBeUndefined();
  });

  it.each([true, false])(
    "converges a file mtime rollback (changed content: %s)",
    async (changed) => {
      const archiveName = "thread.jsonl.deleted.2026-08-01T11-00-00.000Z";
      const timestamp = changed ? undefined : "2026-08-01T10:30:00.000Z";
      const original = await writeSessionFile(
        archiveName,
        changed ? "version before" : "unchanged content",
        timestamp,
      );
      const originalEntry = await readEntry(original.filePath);
      const replacement = changed
        ? await writeSessionFile(archiveName, "version after!")
        : original;
      if (changed) {
        expect(replacement.size).toBe(original.size);
      }
      const rollback = new Date(Math.max(1, original.mtimeMs - 60_000));
      await fs.utimes(replacement.filePath, rollback, rollback);
      const restored = changed ? null : await readEntry(replacement.filePath);
      expect((await fs.stat(replacement.filePath)).mtimeMs).toBeLessThan(original.mtimeMs);
      if (restored) {
        expect(restored.hash).toBe(originalEntry.hash);
      }
      const harness = await Harness.create([sourceRow(originalEntry, original.mtimeMs)], true);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      await expect(harness.catchUp()).resolves.toEqual([replacement.filePath]);
      await flushSessionSync(harness);
      if (changed) {
        expect([harness.syncCalls, harness.indexedPaths, harness.indexedContents]).toEqual([
          [{ reason: "session-startup-catchup" }],
          [`sessions/main/${archiveName}`],
          ["User: version after!"],
        ]);
      } else {
        assert.isNotNull(restored);
        expect(harness.indexedPaths).toEqual([]);
        expect(harness.getIndexedSourceState(originalEntry.path)).toEqual(sourceRow(restored));
        expect(harness.getSourceMetadataUpdateCount()).toBe(1);
        const restarted = harness.restartForStartup();
        await expect(restarted.catchUp()).resolves.toEqual([]);
        expect(restarted).toMatchObject({ syncCalls: [], indexedPaths: [] });
      }
    },
  );

  it("converges a legacy SQLite activity fingerprint without reindexing unchanged text", async () => {
    const session = await writeSqliteSession({ updatedAt: 10 });
    const entry = await readEntry(session.sessionKey, {
      agentId: "main",
      sessionId: session.sessionId,
      storePath: session.storePath,
      sessionKey: session.sessionKey,
      updatedAtMs: 10,
      sessionKind: "interactive",
    });
    const harness = await Harness.create([sourceRow(entry, 20)], true, false);

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const observed = observeHostDataSql();
    try {
      await expect(harness.catchUp()).resolves.toEqual([session.sessionKey]);
      await flushSessionSync(harness);
      const sourceSql = observed.queries.filter((sql) =>
        /\b(?:from|update)\s+["`]?memory_index_sources\b/i.test(sql),
      );
      expect(sourceSql).toEqual([]);
    } finally {
      observed.restore();
    }

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.indexedPaths).toEqual([]);
    expect(harness.indexedContents).toEqual([]);
    expect(harness.getIndexedSourceState(entry.path)).toEqual({
      path: entry.path,
      hash: `sqlite:${entry.revisionMs}:${entry.hash}`,
      mtime: entry.mtimeMs,
      size: entry.size,
    });
    expect(harness.getSourceMetadataUpdateCount()).toBe(1);

    const restarted = harness.restartForStartup();
    await expect(restarted.catchUp()).resolves.toEqual([]);
    expect(restarted.syncCalls).toEqual([]);
    expect(restarted.indexedPaths).toEqual([]);
    await restarted.runArchiveSyncForTest();
    expect(restarted.getSourceMetadataUpdateCount()).toBe(1);
  });

  it("skips corpus preflight when an ordinary sync has no session work", async () => {
    const harness = await Harness.create([]);

    await harness.runSyncForTest({ reason: "session-delta" });

    expect(harness.corpusListCalls).toBe(0);
  });

  it("resolves queued identities once and observes committed appends and tombstones", async () => {
    const storePath = path.join(stateDir, "custom-sessions", "sessions.json");
    const session = await writeSqliteSession({
      storePath,
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
      content: "custom store target",
    });
    const forgotten = await writeSqliteSession({ storePath, sessionId: "forgotten-thread" });
    await writeSqliteSession({ storePath, sessionId: "unrelated-thread" });
    const harness = await Harness.create([], true, false, {
      session: { store: storePath },
    });
    harness.addPendingSessionTarget({
      agentId: "main",
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
    });
    harness.addPendingSessionTarget({ agentId: "main", sessionId: forgotten.sessionId });
    await append(session, "appended after queuing");
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    ensureMemorySessionTombstones(db);
    recordMemorySessionTombstonesInDatabase(db, {
      agentId: "main",
      sessionIds: [forgotten.sessionId, "unrelated-thread"],
    });
    const reads = vi.spyOn(cpuRuntime, "runMemoryOriginRead");
    try {
      await harness.processPendingSessionUpdates();
      await harness.waitForSessionSync();

      expect(harness.syncCalls[0]).toMatchObject({
        sessions: [
          { agentId: "main", sessionId: session.sessionId, sessionKey: session.sessionKey },
          { agentId: "main", sessionId: forgotten.sessionId },
        ],
        archiveFiles: [],
      });
      expect(harness.corpusListCalls).toBe(1);
      expect(harness.indexedPaths).toEqual([session.corpusPath]);
      expect(harness.indexedContents).toEqual([
        "User: custom store target\nUser: appended after queuing",
      ]);
      const queriedSessionIds = reads.mock.calls.flatMap(([request]) =>
        request.kind === "session-tombstones" ? (request.sessionIds ?? []) : [],
      );
      expect(queriedSessionIds.toSorted()).toEqual(
        [session.sessionId, forgotten.sessionId].toSorted(),
      );
    } finally {
      reads.mockRestore();
    }
  });

  it("keeps targeted indexing on the SQLite store resolved by its corpus snapshot", async () => {
    const session = await writeSqliteSession({
      storePath: path.join(stateDir, "custom-sessions", "sessions.json"),
      sessionId: "snapshot-thread",
      sessionKey: "agent:main:chat:snapshot",
      content: "original snapshot target",
    });
    const replacement = await writeSqliteSession({
      storePath: path.join(stateDir, "replacement-sessions", "sessions.json"),
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      content: "replacement store target",
    });
    await configureTestSessionStore(session.storePath);
    const harness = await Harness.create([], false, false, {
      session: { store: session.storePath },
    });
    harness.afterNextCorpusListForTest(async () => {
      await configureTestSessionStore(replacement.storePath);
    });

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [{ agentId: "main", sessionId: session.sessionId, sessionKey: session.sessionKey }],
    });

    expect(harness.corpusListCalls).toBe(1);
    expect(harness.indexedPaths).toEqual([session.corpusPath]);
    expect(harness.indexedContents[0]).toContain("original snapshot target");
    expect(harness.indexedContents[0]).not.toContain("replacement store target");
  });

  it("indexes a persisted SQLite append through the real transcript listener", async () => {
    vi.useFakeTimers();
    const session = await writeSqliteSession();
    const harness = await Harness.create([], true, true);
    const turnContext = new AsyncLocalStorage<string>();
    const pendingInputContext = new AsyncLocalStorage<string>();
    turnContext.run("opening turn", () => harness.startTranscriptListener());
    const timerContexts: Array<{ turn?: string; pendingInput?: string }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const timerObserver = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
      if (args[1] === 30_000) {
        timerContexts.push({
          turn: turnContext.getStore(),
          pendingInput: pendingInputContext.getStore(),
        });
      }
      return originalSetTimeout(...args);
    });

    try {
      await turnContext.run("later turn", () =>
        pendingInputContext.run("later input", async () => {
          await append(session, "persisted listener update", "assistant");
          await publishSessionTranscriptUpdateByIdentity(session);
          expect(turnContext.getStore()).toBe("later turn");
          expect(pendingInputContext.getStore()).toBe("later input");
        }),
      );
      expect(timerContexts).toEqual([{ turn: undefined, pendingInput: undefined }]);

      await vi.advanceTimersByTimeAsync(31_000);
      await harness.waitForCorpusList();
      await harness.waitForSessionSync();

      expect(harness.indexedPaths).toEqual([session.corpusPath]);
      expect(harness.indexedContents).toEqual([
        "User: startup catchup\nAssistant: persisted listener update",
      ]);
    } finally {
      harness.stopTranscriptListener();
      timerObserver.mockRestore();
    }
  });

  it("indexes a real SQLite delete archive through the transcript listener", async () => {
    vi.useFakeTimers();
    const session = await writeSqliteSession({ content: "lifecycle archive memory" });
    const harness = await Harness.create([], true, true);
    harness.startTranscriptListener();

    try {
      await expect(
        deleteSessionEntry({
          agentId: "main",
          archiveTranscript: true,
          expectedSessionId: session.sessionId,
          sessionKey: session.sessionKey,
          storePath: session.storePath,
        }),
      ).resolves.toBe(true);
      await harness.waitForCorpusList();
      expect(harness.getPendingArchiveFiles()).toHaveLength(1);

      await flushSessionSync(harness, 31_000);

      expect(harness.indexedPaths).toHaveLength(1);
      expect(harness.indexedPaths[0]).toMatch(
        /^sessions\/main\/thread\.jsonl\.deleted\..+(?:\.zst)?$/,
      );
      expect(harness.indexedContents).toEqual(["User: lifecycle archive memory"]);
    } finally {
      harness.stopTranscriptListener();
    }
  });

  it.each(["thread.trajectory.jsonl.reset.2026-06-23T10-00-00.000Z.zst"])(
    "ignores non-corpus session artifact updates for %s",
    async (fileName) => {
      vi.useFakeTimers();
      const session = await writeSessionFile(fileName);
      const harness = await Harness.create([], true);
      harness.startTranscriptListener();

      try {
        emitSessionTranscriptUpdate({ sessionFile: session.filePath });
        await harness.waitForCorpusList();
        await flushSessionSync(harness, 31_000);

        expect([harness.getPendingArchiveFiles(), harness.getDirtyArchiveFiles()]).toEqual([
          [],
          [],
        ]);
        expect([harness.syncCalls, harness.indexedPaths]).toEqual([[], []]);
      } finally {
        harness.stopTranscriptListener();
      }
    },
  );
});
