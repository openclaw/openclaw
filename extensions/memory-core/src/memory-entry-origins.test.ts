import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  useSqliteWorkerFault,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMemoryPreimages, storeMemoryPreimage } from "./dreaming-consolidation-artifacts.js";
import { readMemoryOriginsInWorker } from "./memory-entry-origin-reads.js";
import { deleteMemoryEntryOriginsInDatabase } from "./memory-entry-origins-delete.js";
import {
  findForgottenMemorySessionIds,
  listMemoryEntryOrigins,
  pruneMemoryEntryOrigins,
  recordMemoryEntryOrigins,
  reserveMemoryEntryOrigins,
  type MemoryEntryOrigin,
} from "./memory-entry-origins.js";
import { memoryOrigin as origin } from "./memory-forget.suite.test-support.js";
import {
  ensureMemorySessionTombstones,
  hasMemorySessionTombstone,
  recordMemorySessionTombstonesInDatabase,
} from "./memory-session-tombstones.js";
import * as cpuRuntime from "./memory/manager-cpu-worker-runtime.js";
import { buildPromotionMarker } from "./short-term-promotion-memory-write.js";
import {
  configureMemoryCoreDreamingStateForTests,
  readMemoryForgetTombstonesForTest,
  resetMemoryCoreDreamingStateForTests,
  seedMemoryForgetTombstones,
} from "./test-helpers.js";

const reservationFault = useSqliteWorkerFault([
  {
    match: /^insert into memory_entry_origins /,
    name: "reservation_write",
    sql: `CREATE TEMP TRIGGER reservation_write BEFORE INSERT ON memory_entry_origins
      WHEN NEW.agent_id = 'secondary' AND NEW.entry_key = 'failing'
      BEGIN SELECT RAISE(ABORT, 'fixture reservation write rejected'); END`,
  },
  {
    match: /^delete from memory_entry_origins /,
    name: "reservation_cleanup",
    sql: `CREATE TEMP TRIGGER reservation_cleanup BEFORE DELETE ON memory_entry_origins
      WHEN OLD.entry_key = 'first'
      BEGIN SELECT RAISE(ABORT, 'fixture reservation cleanup rejected'); END`,
  },
]);

describe("memory entry origins", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-origin-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await configureMemoryCoreDreamingStateForTests();
    await fs.mkdir(path.dirname(databasePath()), { recursive: true });
  });

  afterEach(async () => {
    resetMemoryCoreDreamingStateForTests();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const databasePath = () => resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const database = () =>
    requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
  const record = (origins: MemoryEntryOrigin[], agentId = "main") =>
    recordMemoryEntryOrigins({ agentId, origins });
  const list = (
    filter: Omit<Parameters<typeof listMemoryEntryOrigins>[0], "agentId"> = {},
    agentId = "main",
  ) => listMemoryEntryOrigins({ agentId, ...filter });
  const forgotten = (sessionIds: string[], agentId = "main") =>
    findForgottenMemorySessionIds({ agentId, sessionIds });
  const row = (sql: string) => database().prepare(sql).get();
  const table = (name: string) => row(`SELECT name FROM sqlite_schema WHERE name = '${name}'`);
  const revision = () => row("SELECT revision FROM memory_index_state WHERE id = 1");
  const seedTombstones = (sessionIds: string[], createdAt = 1_000, reason = "forgotten") =>
    seedMemoryForgetTombstones({ agentId: "main", sessionIds, createdAt, reason });
  const prune = (
    entryKeys: string[],
    retainedEntryKeys = new Set<string>(),
    workspaceDir = stateDir,
  ) => pruneMemoryEntryOrigins({ workspaceDir, agentIds: ["main"], entryKeys, retainedEntryKeys });
  const remove = (
    filter: Omit<Parameters<typeof deleteMemoryEntryOriginsInDatabase>[1], "agentId">,
  ) =>
    withOpenClawAgentDatabaseWrite({ agentId: "main" }, ({ db }) =>
      deleteMemoryEntryOriginsInDatabase(requireNativeSqliteDatabase(db), {
        agentId: "main",
        ...filter,
      }),
    );
  const reserve = (priorEntry: string, candidateKeys = ["candidate"], agentIds = ["main"]) =>
    reserveMemoryEntryOrigins({
      agentIds,
      previousMemory: `${buildPromotionMarker("prior")}\n${priorEntry}\n`,
      operations: candidateKeys.map((candidateKey) => ({
        candidateKey,
        action: "merged" as const,
        priorEntries: [priorEntry],
      })),
    });
  const readTombstones = (sessionIds: string[]) =>
    readMemoryOriginsInWorker({
      agentId: "main",
      stateDir,
      databasePath: databasePath(),
      kind: "session-tombstones",
      sessionIds,
    });

  it("lazily restores the additive origins table without changing the agent schema version", async () => {
    await prune(["candidate"]);
    await expect(fs.access(databasePath())).rejects.toThrow();
    const db = database();
    const version = db.prepare("PRAGMA user_version").get();
    db.exec("DROP TABLE IF EXISTS memory_entry_origins");

    expect(await list()).toEqual([]);
    await prune(["candidate"]);
    expect(table("memory_entry_origins")).toBeUndefined();
    await expect(
      record([
        origin("rejected", "session-1"),
        { ...origin("rejected", "other"), agentId: "other" },
      ]),
    ).rejects.toThrow("memory entry origin belongs to another agent");
    expect(table("memory_entry_origins")).toEqual({ name: "memory_entry_origins" });
    expect(await list()).toEqual([]);
    await record([origin("candidate", "session-1")]);
    await record([origin("candidate", "session-1")]);

    expect(await list()).toEqual([origin("candidate", "session-1")]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    db.exec("DROP TABLE memory_entry_origins");
    await record([origin("recovered", "session-2")]);
    expect(await list()).toEqual([origin("recovered", "session-2")]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
  });

  it("keeps queued origin input and state placement with the original caller", async () => {
    const original = origin("queued", "session-1");
    const options = { agentId: "main", env: { ...process.env } };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = record([original]);
    const alternate = path.join(stateDir, "alternate-state");
    try {
      original.sessionId = "changed-after-queue";
      vi.stubEnv("OPENCLAW_STATE_DIR", alternate);
      expect(await list()).toEqual([]);
      await expect(fs.access(resolveOpenClawAgentSqlitePath(options))).rejects.toThrow();
    } finally {
      release.resolve();
      await blocker;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await pending;
    }
    await expect(pending).resolves.toEqual([origin("queued", "session-1")]);
    expect(await list()).toEqual([origin("queued", "session-1")]);
    const dispatch = Promise.withResolvers<void>();
    const run = cpuRuntime.runMemoryOriginRead;
    const transport = vi
      .spyOn(cpuRuntime, "runMemoryOriginRead")
      .mockImplementationOnce(async (...args) => {
        await dispatch.promise;
        return run(...args);
      });
    const sessionIds = ["session-1"];
    const reading = list({ sessionIds });
    try {
      sessionIds[0] = "changed-after-dispatch";
      vi.stubEnv("OPENCLAW_STATE_DIR", alternate);
      dispatch.resolve();
      expect(await reading).toEqual([origin("queued", "session-1")]);
    } finally {
      dispatch.resolve();
      await reading.catch(() => undefined);
      transport.mockRestore();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    }
    await expect(fs.access(alternate)).rejects.toThrow();
  });

  it("lazily persists forgotten sessions without recreating tombstones on reads or repeat writes", async () => {
    const db = database();
    const version = db.prepare("PRAGMA user_version").get();
    const revisionBefore = revision();
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");

    expect(await forgotten(["session-1"])).toEqual(new Set());
    expect(await forgotten([])).toEqual(new Set());
    expect(table("memory_session_tombstones")).toBeUndefined();
    await record([origin("candidate", "session-1")]);
    expect(table("memory_session_tombstones")).toBeUndefined();

    expect(seedTombstones(["session-2", "session-1", "session-1"])).toBe(2);
    const deletionRevision = revision();
    expect(deletionRevision).not.toEqual(revisionBefore);
    expect(seedTombstones(["session-1"], 2_000, "replacement")).toBe(0);
    expect(revision()).toEqual(deletionRevision);
    expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual([
      { sessionId: "session-1", agentId: "main", reason: "forgotten", createdAt: 1_000 },
      { sessionId: "session-2", agentId: "main", reason: "forgotten", createdAt: 1_000 },
    ]);
    expect(await forgotten(["session-2"])).toEqual(new Set(["session-2"]));
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
  });

  it("publishes committed tombstones and forgets facts when their table is recreated", () => {
    const db = database();
    ensureMemorySessionTombstones(db);
    expect(hasMemorySessionTombstone(db, "main", "committed")).toBe(false);
    recordMemorySessionTombstonesInDatabase(db, { agentId: "main", sessionIds: ["committed"] });
    expect(hasMemorySessionTombstone(db, "main", "committed")).toBe(true);
    expect(
      recordMemorySessionTombstonesInDatabase(db, { agentId: "other", sessionIds: ["committed"] }),
    ).toBe(0);
    expect(hasMemorySessionTombstone(db, "other", "committed")).toBe(false);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        recordMemorySessionTombstonesInDatabase(db, {
          agentId: "main",
          sessionIds: ["rolled-back"],
        });
        expect(hasMemorySessionTombstone(db, "main", "rolled-back")).toBe(true);
        throw new Error("rollback tombstone");
      }),
    ).toThrow("rollback tombstone");
    expect(hasMemorySessionTombstone(db, "main", "rolled-back")).toBe(false);
    expect(hasMemorySessionTombstone(db, "main", "committed")).toBe(true);
    db.exec("DROP TABLE memory_session_tombstones");
    ensureMemorySessionTombstones(db);
    expect(hasMemorySessionTombstone(db, "main", "committed")).toBe(false);
  });

  it("filters origins and tombstones by selections larger than SQLite's parameter limit", async () => {
    const variableLimit = openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("PRAGMA compile_options")
      .all()
      .map((option) => String(option.compile_options))
      .find((option) => option.startsWith("MAX_VARIABLE_NUMBER="));
    const selected = (prefix: string, ...ids: string[]) => [
      ...ids,
      ...Array.from(
        { length: Number(variableLimit?.split("=")[1] ?? 32766) + 1 },
        (_, index) => `${prefix}-missing-${index}`,
      ),
    ];
    const kept = origin("kept", "session-1");
    const pruned = origin("pruned", "session-2");
    await record([kept, origin("kept", "session-3"), pruned]);
    seedTombstones(["session-2"]);

    expect(await list({ sessionIds: selected("session", "session-1") })).toEqual([kept]);
    expect(await list({ entryKeys: selected("key", "pruned") })).toEqual([pruned]);
    expect(await forgotten(selected("session", "session-2"))).toEqual(new Set(["session-2"]));

    await prune(selected("key", "pruned"));
    expect(await list()).toEqual([kept, origin("kept", "session-3")]);
    await expect(
      remove({ entryKeys: ["kept"], sessionIds: selected("session", "session-3") }),
    ).resolves.toBe(1);
    expect(await list()).toEqual([kept]);
  });

  it("bounds tombstone replies while reusing committed membership across pages", async () => {
    const sessionIds = Array.from({ length: 513 }, (_, index) => `forgotten-${index}`);
    sessionIds[255] = `long-${"x".repeat(64 * 1024)}`;
    sessionIds[256] = "nul-\0-🦞";
    seedTombstones(sessionIds, 1_000, "x".repeat(1024));
    expect(readTombstones(sessionIds)).toEqual({
      kind: "session-tombstones",
      indices: Array.from({ length: 256 }, (_, i) => i),
    });
    expect(await forgotten(["missing", ...sessionIds, sessionIds[0]!])).toEqual(
      new Set(sessionIds),
    );
    expect(await forgotten(sessionIds, "other")).toEqual(new Set());
  });

  it("rolls back only newly reserved lineage when a replacement does not commit", async () => {
    const priorEntry = "- Keep the original deployment target.";
    const prior = Array.from({ length: 32 }, (_, index) =>
      origin("prior", `session-${String(index).padStart(2, "0")}`),
    );
    const existing = origin("candidate", "session-existing");
    const original = [existing, ...prior];
    await record(original);
    for (const filter of [
      { entryKeys: [] },
      { entryKeys: ["candidate"], sessionIds: [] },
      { entryKeys: ["missing"] },
      { entryKeys: ["candidate"], sessionIds: ["session-1"] },
    ]) {
      await expect(remove(filter)).resolves.toBe(0);
    }
    expect(await list()).toEqual(original);
    const rollback = await reserve(priorEntry);
    expect(await list({ entryKeys: ["candidate"] })).toEqual([
      ...prior.map((entry) => origin("candidate", entry.sessionId)),
      existing,
    ]);

    await rollback();

    expect(await list()).toEqual(original);
  });

  it.each([false, true])(
    "settles committed agent reservations before rejecting (cleanup failure=%s)",
    async (cleanupFails) => {
      const prior = origin("prior", "session-1");
      await record([prior]);
      const secondaryPrior = {
        ...prior,
        agentId: "secondary",
        sessionKey: "agent:secondary:session-1",
      };
      await record([secondaryPrior], "secondary");
      reservationFault.enable(0);
      if (cleanupFails) {
        reservationFault.enable(1);
      }
      const priorEntry = "- Retain the source until publication settles.";
      try {
        // Each agent's batch is atomic; a later agent failure exercises committed-prefix cleanup.
        await expect(
          reserve(priorEntry, ["first", "failing"], ["main", "secondary"]),
        ).rejects.toThrow(
          cleanupFails
            ? "fixture reservation cleanup rejected"
            : "fixture reservation write rejected",
        );
        expect(await list()).toEqual(
          cleanupFails ? [origin("first", "session-1"), prior] : [prior],
        );
        expect(await list({}, "secondary")).toEqual([secondaryPrior]);
      } finally {
        reservationFault.disable();
      }
    },
  );

  it("refuses compensation against a replacement of the originally reserved database", async () => {
    const prior = origin("prior", "session-1");
    await record([prior]);
    const priorEntry = "- Keep the original source identity.";
    const rollback = await reserve(priorEntry);
    const before = await list();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    const pathname = databasePath();
    await fs.rename(pathname, `${pathname}.original`);
    await fs.copyFile(`${pathname}.original`, pathname);

    const [outcome] = await Promise.allSettled([rollback()]);
    expect(await list()).toEqual(before);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { message: "Memory reindex shadow file changed during its owned lifetime" },
    });
  });

  it.each(["DREAMS.md"])(
    "retains diary-only lineage in %s after backup rotation",
    async (diaryName) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir);
      const diaryPath = path.join(workspaceDir, diaryName);
      await fs.writeFile(
        diaryPath,
        `${buildPromotionMarker("diary")}\n- Retained diary excerpt.\n`,
      );
      const retainedEntryKeys = new Set(["current", "staged"]);
      const save = (keys: string[], nowMs: number) =>
        storeMemoryPreimage({
          workspaceDir,
          agentIds: ["main"],
          content: keys.map((key) => `${buildPromotionMarker(key)}\n- ${key}`).join("\n"),
          retainedEntryKeys,
          nowMs,
        });
      await record(
        ["current", "diary", "expired", "indexed", "shared", "staged"].map((key) =>
          origin(key, key),
        ),
      );
      const db = database();
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, 'memory', 1, 2, ?, 'fts-only', ?, x'', 1000)",
      ).run(
        "older-memory",
        "MEMORY.md",
        "older-memory-hash",
        `# Memory\n${buildPromotionMarker("indexed")}`,
      );
      await save(["diary", "expired", "indexed", "shared", "staged"], 1_000);
      await save(["shared"], 2_000);
      for (let index = 3; index <= 9; index += 1) {
        await save(["current"], index * 1_000);
      }
      expect(await readMemoryPreimages(workspaceDir)).toHaveLength(8);
      expect((await list()).map((entry) => entry.entryKey)).toEqual([
        "current",
        "diary",
        "indexed",
        "shared",
        "staged",
      ]);

      await save(["current"], 10_000);

      expect(await readMemoryPreimages(workspaceDir)).toHaveLength(8);
      expect((await list()).map((entry) => entry.entryKey)).toEqual([
        "current",
        "diary",
        "indexed",
        "staged",
      ]);
      await fs.unlink(diaryPath);
      await prune(["diary"], retainedEntryKeys, workspaceDir);
      expect(await list({ entryKeys: ["diary"] })).toEqual([]);
    },
  );
});
