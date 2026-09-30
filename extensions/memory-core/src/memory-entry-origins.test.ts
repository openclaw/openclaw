import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteQueryCompiler } from "kysely";
import {
  ensureMemoryEntryOriginsSchema,
  recordMemoryEntryOriginsInDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
  runSqliteImmediateTransactionSync,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMemoryPreimages, storeMemoryPreimage } from "./dreaming-consolidation-artifacts.js";
import {
  deleteMemoryEntryOriginsInDatabase,
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  pruneMemoryEntryOrigins,
  recordMemoryEntryOrigins,
  reserveMemoryEntryOrigins,
  type MemoryEntryOrigin,
} from "./memory-entry-origins.js";
import { buildPromotionMarker, extractPromotionKeys } from "./short-term-promotion-memory-write.js";
import { recordShortTermRecalls } from "./short-term-promotion-record.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  seedMemoryForgetTombstones,
} from "./test-helpers.js";

describe("memory entry origins", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-origin-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await configureMemoryCoreDreamingStateForTests();
    await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
      recursive: true,
    });
  });

  afterEach(async () => {
    resetMemoryCoreDreamingStateForTests();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function origin(entryKey: string, sessionId: string): MemoryEntryOrigin {
    return {
      entryKey,
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      originClass: "owner",
      observedAt: 1_000,
    };
  }

  it("lazily restores the additive origins table without changing the agent schema version", async () => {
    const pruning = {
      workspaceDir: stateDir,
      agentIds: ["main"],
      entryKeys: ["candidate"],
      retainedEntryKeys: new Set<string>(),
    };
    await pruneMemoryEntryOrigins(pruning);
    await expect(fs.access(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).rejects.toThrow();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const version = db.prepare("PRAGMA user_version").get();
    db.exec("DROP TABLE IF EXISTS memory_entry_origins");

    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    await pruneMemoryEntryOrigins(pruning);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_entry_origins'").get(),
    ).toBeUndefined();
    await expect(
      recordMemoryEntryOrigins({
        agentId: "main",
        origins: [
          origin("rejected", "session-1"),
          { ...origin("rejected", "other"), agentId: "other" },
        ],
      }),
    ).rejects.toThrow("memory entry origin belongs to another agent");
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_entry_origins'").get(),
    ).toEqual({ name: "memory_entry_origins" });
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("candidate", "session-1")],
    });
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("candidate", "session-1")],
    });

    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([origin("candidate", "session-1")]);
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
    const pending = recordMemoryEntryOrigins({ agentId: "main", origins: [original] });
    const alternate = path.join(stateDir, "alternate-state");
    try {
      original.sessionId = "changed-after-queue";
      vi.stubEnv("OPENCLAW_STATE_DIR", alternate);
      expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
      await expect(fs.access(resolveOpenClawAgentSqlitePath(options))).rejects.toThrow();
    } finally {
      release.resolve();
      await blocker;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await pending;
    }
    await expect(pending).resolves.toEqual([origin("queued", "session-1")]);
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([origin("queued", "session-1")]);
    await expect(fs.access(alternate)).rejects.toThrow();
  });

  it("lazily persists forgotten sessions without recreating tombstones on reads or repeat writes", async () => {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const version = db.prepare("PRAGMA user_version").get();
    const revisionBefore = db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");

    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
    expect(listMemorySessionTombstones({ agentId: "main", sessionIds: [] })).toEqual([]);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_session_tombstones'").get(),
    ).toBeUndefined();
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("candidate", "session-1")],
    });
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_session_tombstones'").get(),
    ).toBeUndefined();

    expect(
      seedMemoryForgetTombstones({
        agentId: "main",
        sessionIds: ["session-2", "session-1", "session-1"],
        createdAt: 1_000,
      }),
    ).toBe(2);
    const deletionRevision = db
      .prepare("SELECT revision FROM memory_index_state WHERE id = 1")
      .get();
    expect(deletionRevision).not.toEqual(revisionBefore);
    expect(
      seedMemoryForgetTombstones({
        agentId: "main",
        sessionIds: ["session-1"],
        reason: "replacement",
        createdAt: 2_000,
      }),
    ).toBe(0);
    expect(db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual(
      deletionRevision,
    );
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([
      { sessionId: "session-1", agentId: "main", reason: "forgotten", createdAt: 1_000 },
      { sessionId: "session-2", agentId: "main", reason: "forgotten", createdAt: 1_000 },
    ]);
    expect(listMemorySessionTombstones({ agentId: "main", sessionIds: ["session-2"] })).toEqual([
      { sessionId: "session-2", agentId: "main", reason: "forgotten", createdAt: 1_000 },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
  });

  it("unions every parent session onto a merged entry and removes its retired parent key", async () => {
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("prior", "session-1"), origin("candidate", "session-2")],
    });
    const priorEntry = "- The deployment target is staging.";
    const previousMemory = `# Memory\n<!-- openclaw-memory-promotion:prior -->\n${priorEntry}\n`;
    const currentMemory = `# Memory\n<!-- openclaw-memory-promotion:candidate -->\n- The deployment target is staging. Source: memory/a.md#L1-L1\n`;

    await reserveMemoryEntryOrigins({
      agentIds: ["main"],
      previousMemory,
      operations: [
        {
          candidateKey: "candidate",
          action: "merged",
          priorEntries: [priorEntry],
        },
      ],
    });
    await pruneMemoryEntryOrigins({
      workspaceDir: stateDir,
      agentIds: ["main"],
      entryKeys: extractPromotionKeys(previousMemory),
      retainedEntryKeys: new Set(extractPromotionKeys(currentMemory)),
    });

    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([
      origin("candidate", "session-1"),
      origin("candidate", "session-2"),
    ]);
    expect(listMemoryEntryOrigins({ agentId: "main", entryKeys: ["prior"] })).toEqual([]);
  });

  it("re-keys superseded session lineage while preserving unrelated live memory", async () => {
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("stale", "session-1"), origin("surviving", "session-3")],
    });
    const priorEntry = "- The deployment target is staging.";
    const previousMemory = `<!-- openclaw-memory-lineage:target -->\n<!-- openclaw-memory-promotion:stale -->\n${priorEntry}\n<!-- openclaw-memory-promotion:surviving -->\n- Keep this independent memory.\n`;
    const currentMemory = `<!-- openclaw-memory-promotion:surviving -->\n- Keep this independent memory.\n<!-- openclaw-memory-lineage:target -->\n<!-- openclaw-memory-promotion:replacement -->\n- The deployment target is production.\n`;

    await reserveMemoryEntryOrigins({
      agentIds: ["main"],
      previousMemory,
      operations: [
        {
          candidateKey: "replacement",
          action: "superseded",
          priorEntries: [priorEntry],
        },
      ],
    });
    await pruneMemoryEntryOrigins({
      workspaceDir: stateDir,
      agentIds: ["main"],
      entryKeys: extractPromotionKeys(previousMemory),
      retainedEntryKeys: new Set(extractPromotionKeys(currentMemory)),
    });

    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([
      origin("replacement", "session-1"),
      origin("surviving", "session-3"),
    ]);
    await expect(
      withOpenClawAgentDatabaseWrite({ agentId: "main" }, ({ db }) =>
        deleteMemoryEntryOriginsInDatabase(db, { agentId: "main", entryKeys: ["replacement"] }),
      ),
    ).resolves.toBe(1);
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([origin("surviving", "session-3")]);
  });

  it("rolls back only newly reserved lineage when a replacement does not commit", async () => {
    const priorEntry = "- Keep the original deployment target.";
    const prior = Array.from({ length: 32 }, (_, index) =>
      origin("prior", `session-${String(index).padStart(2, "0")}`),
    );
    const existing = origin("candidate", "session-existing");
    const original = [existing, ...prior];
    await recordMemoryEntryOrigins({ agentId: "main", origins: original });
    for (const filter of [
      { entryKeys: [] },
      { entryKeys: ["candidate"], sessionIds: [] },
      { entryKeys: ["missing"] },
      { entryKeys: ["candidate"], sessionIds: ["session-1"] },
    ]) {
      await expect(
        withOpenClawAgentDatabaseWrite({ agentId: "main" }, ({ db }) =>
          deleteMemoryEntryOriginsInDatabase(db, { agentId: "main", ...filter }),
        ),
      ).resolves.toBe(0);
    }
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(original);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const calibration = "UPDATE memory_entry_origins SET observed_at = observed_at WHERE 0";
    const observation = observeHostDataSql();
    try {
      db.prepare(calibration).run();
      expect(observation.queries).toContain(calibration);
      observation.queries.length = 0;
      const rollback = await reserveMemoryEntryOrigins({
        agentIds: ["main"],
        previousMemory: `${buildPromotionMarker("prior")}\n${priorEntry}\n`,
        operations: [{ candidateKey: "candidate", action: "merged", priorEntries: [priorEntry] }],
      });
      expect(listMemoryEntryOrigins({ agentId: "main", entryKeys: ["candidate"] })).toEqual([
        ...prior.map((entry) => origin("candidate", entry.sessionId)),
        existing,
      ]);

      await rollback();

      expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(original);
      expect(
        observation.queries.filter((sql) =>
          /\b(?:insert\s+into|update|delete\s+from)\s+"?memory_entry_origins\b/iu.test(sql),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it("compiles a bounded insert plan for a batch without replacing existing origins", async () => {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    ensureMemoryEntryOriginsSchema(db);
    const existing = origin("candidate", "existing");
    runSqliteImmediateTransactionSync(db, () =>
      recordMemoryEntryOriginsInDatabase(db, { agentId: "main", origins: [existing] }),
    );
    const batch = Array.from({ length: 32 }, (_, index) =>
      origin("prior", `session-${String(index).padStart(2, "0")}`),
    );
    const compile = vi.spyOn(SqliteQueryCompiler.prototype, "compileQuery");
    try {
      const inserted = await withOpenClawAgentDatabaseWrite(
        { agentId: "main" },
        ({ db: admitted }) =>
          runSqliteImmediateTransactionSync(admitted, () =>
            recordMemoryEntryOriginsInDatabase(admitted, {
              agentId: "main",
              entryKey: "candidate",
              origins: [...batch, { ...existing, observedAt: 9_000 }],
            }),
          ),
      );
      expect(inserted).toEqual(batch.map(({ sessionId }) => origin("candidate", sessionId)));
      expect(listMemoryEntryOrigins({ agentId: "main", sessionIds: ["existing"] })).toEqual([
        existing,
      ]);
      const inserts = compile.mock.results.filter(
        (result) =>
          result.type === "return" &&
          result.value.sql.startsWith('insert into "memory_entry_origins"'),
      ).length;
      expect(inserts).toBeGreaterThan(0);
      expect(inserts).toBeLessThanOrEqual(2);
    } finally {
      compile.mockRestore();
    }
  });

  it.each([false, true])(
    "settles the successful reservation prefix before rejecting (cleanup failure=%s)",
    async (cleanupFails) => {
      const prior = origin("prior", "session-1");
      await recordMemoryEntryOrigins({ agentId: "main", origins: [prior] });
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.exec(`
        CREATE TRIGGER reject_origin_reservation BEFORE INSERT ON memory_entry_origins
        WHEN NEW.entry_key = 'failing'
        BEGIN SELECT RAISE(ABORT, 'fixture reservation write rejected'); END;
      `);
      if (cleanupFails) {
        db.exec(`
          CREATE TRIGGER reject_origin_compensation BEFORE DELETE ON memory_entry_origins
          WHEN OLD.entry_key = 'first'
          BEGIN SELECT RAISE(ABORT, 'fixture reservation cleanup rejected'); END;
        `);
      }
      const priorEntry = "- Retain the source until publication settles.";
      await expect(
        reserveMemoryEntryOrigins({
          agentIds: ["main"],
          previousMemory: `${buildPromotionMarker("prior")}\n${priorEntry}\n`,
          operations: ["first", "failing"].map((candidateKey) => ({
            candidateKey,
            action: "merged" as const,
            priorEntries: [priorEntry],
          })),
        }),
      ).rejects.toThrow(
        cleanupFails
          ? "fixture reservation cleanup rejected"
          : "fixture reservation write rejected",
      );
      expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(
        cleanupFails ? [origin("first", "session-1"), prior] : [prior],
      );
    },
  );

  it("refuses compensation against a replacement of the originally reserved database", async () => {
    const prior = origin("prior", "session-1");
    await recordMemoryEntryOrigins({ agentId: "main", origins: [prior] });
    const priorEntry = "- Keep the original source identity.";
    const rollback = await reserveMemoryEntryOrigins({
      agentIds: ["main"],
      previousMemory: `${buildPromotionMarker("prior")}\n${priorEntry}\n`,
      operations: [{ candidateKey: "candidate", action: "merged", priorEntries: [priorEntry] }],
    });
    const before = listMemoryEntryOrigins({ agentId: "main" });
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    const pathname = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.rename(pathname, `${pathname}.original`);
    await fs.copyFile(`${pathname}.original`, pathname);

    const [outcome] = await Promise.allSettled([rollback()]);
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { message: "Agent database target changed before write admission" },
    });
  });

  it("keeps fresh origin values and insertion order across conflicts and failed reservations", async () => {
    const first = origin("candidate", "session-z");
    const second: MemoryEntryOrigin = {
      entryKey: "candidate",
      agentId: "main",
      sessionId: "session-a",
      sessionKey: null,
      originClass: "agent",
      observedAt: 2_000,
    };
    const third: MemoryEntryOrigin = {
      entryKey: "candidate",
      agentId: "main",
      sessionId: "session-m",
      sessionKey: "agent:main:漢😀",
      originClass: "system",
      observedAt: 3_000,
    };
    expect(
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [first, second, { ...first, observedAt: 9_000 }, third],
      }),
    ).toEqual([first, second, third]);
    const before = [second, third, first];
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before);
    await expect(
      recordMemoryEntryOrigins({
        agentId: "main",
        origins: [origin("next", "new-session"), { ...second, agentId: "other" }],
      }),
    ).rejects.toThrow("memory entry origin belongs to another agent");
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before);
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before);
  });

  it.each(["DREAMS.md", "dreams.md"])(
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
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: ["current", "diary", "expired", "indexed", "shared", "staged"].map((key) =>
          origin(key, key),
        ),
      });
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
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
      expect(listMemoryEntryOrigins({ agentId: "main" }).map((entry) => entry.entryKey)).toEqual([
        "current",
        "diary",
        "indexed",
        "shared",
        "staged",
      ]);

      await save(["current"], 10_000);

      expect(await readMemoryPreimages(workspaceDir)).toHaveLength(8);
      expect(listMemoryEntryOrigins({ agentId: "main" }).map((entry) => entry.entryKey)).toEqual([
        "current",
        "diary",
        "indexed",
        "staged",
      ]);
      await fs.unlink(diaryPath);
      await pruneMemoryEntryOrigins({
        workspaceDir,
        agentIds: ["main"],
        entryKeys: ["diary"],
        retainedEntryKeys,
      });
      expect(listMemoryEntryOrigins({ agentId: "main", entryKeys: ["diary"] })).toEqual([]);
    },
  );

  it("records exact session identity when a transcript recall candidate is first produced", async () => {
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("calibration", "calibration-session")],
    });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const calibration = "UPDATE memory_entry_origins SET observed_at = observed_at WHERE 0";
    const observation = observeHostDataSql();
    try {
      db.prepare(calibration).run();
      expect(observation.queries).toContain(calibration);
      observation.queries.length = 0;
      await recordShortTermRecalls({
        workspaceDir,
        query: "deployment target",
        results: [
          {
            path: "memory/.dreams/session-corpus/2026-08-25.txt",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet: "The deployment target is staging.",
            source: "memory",
            provenance: {
              originClass: "owner",
              sessionKind: "interactive",
              observedAt: 1_000,
            },
            sessionOrigin: {
              agentId: "main",
              sessionId: "session-1",
              sessionKey: "agent:main:session-1",
            },
          },
        ],
        nowMs: 1_000,
      });
      expect(
        observation.queries.filter((sql) =>
          /\b(?:insert\s+into|update|delete\s+from)\s+"?memory_entry_origins\b/iu.test(sql),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }

    expect(listMemoryEntryOrigins({ agentId: "main", sessionIds: ["session-1"] })).toEqual([
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        originClass: "owner",
        observedAt: 1_000,
      }),
    ]);
  });
});
