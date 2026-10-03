import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMemoryPreimages, storeMemoryPreimage } from "./dreaming-consolidation-artifacts.js";
import { deleteMemoryEntryOriginsInDatabase } from "./memory-entry-origins-delete.js";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  pruneMemoryEntryOrigins,
  recordMemoryEntryOrigins,
  reserveMemoryEntryOrigins,
  type MemoryEntryOrigin,
} from "./memory-entry-origins.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import * as cpuRuntime from "./memory/manager-cpu-worker-runtime.js";
import { buildPromotionMarker } from "./short-term-promotion-memory-write.js";
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
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
    let transactionAdmissions = 0;
    const observed = vi
      .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation((options, source, worker) => {
        if (
          worker.moduleUrl.href !==
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href
        ) {
          return open(options, source, worker);
        }
        return open(options, source, {
          ...worker,
          assertAdmission(request) {
            if (request.stage === "transaction") {
              transactionAdmissions += 1;
            }
            return worker.assertAdmission ? worker.assertAdmission(request) : request;
          },
        });
      });
    try {
      const pruning = {
        workspaceDir: stateDir,
        agentIds: ["main"],
        entryKeys: ["candidate"],
        retainedEntryKeys: new Set<string>(),
      };
      await pruneMemoryEntryOrigins(pruning);
      await expect(
        fs.access(resolveOpenClawAgentSqlitePath({ agentId: "main" })),
      ).rejects.toThrow();
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      const version = db.prepare("PRAGMA user_version").get();
      db.exec("DROP TABLE IF EXISTS memory_entry_origins");

      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
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
      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
      expect(transactionAdmissions).toBe(2);
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [origin("candidate", "session-1")],
      });
      expect(transactionAdmissions).toBe(3);
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [origin("candidate", "session-1")],
      });
      expect(transactionAdmissions).toBe(4);

      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([
        origin("candidate", "session-1"),
      ]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
      db.exec("DROP TABLE memory_entry_origins");
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [origin("recovered", "session-2")],
      });
      expect(transactionAdmissions).toBe(6);
      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([
        origin("recovered", "session-2"),
      ]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    } finally {
      observed.mockRestore();
    }
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
      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
      await expect(fs.access(resolveOpenClawAgentSqlitePath(options))).rejects.toThrow();
    } finally {
      release.resolve();
      await blocker;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await pending;
    }
    await expect(pending).resolves.toEqual([origin("queued", "session-1")]);
    expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([
      origin("queued", "session-1"),
    ]);
    const dispatch = Promise.withResolvers<void>();
    const run = cpuRuntime.runMemoryOriginRows;
    const transport = vi
      .spyOn(cpuRuntime, "runMemoryOriginRows")
      .mockImplementationOnce(async (...args) => {
        await dispatch.promise;
        return run(...args);
      });
    const sessionIds = ["session-1"];
    const reading = listMemoryEntryOrigins({ agentId: "main", sessionIds });
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
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const version = db.prepare("PRAGMA user_version").get();
    const revisionBefore = db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");

    expect(await listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
    expect(await listMemorySessionTombstones({ agentId: "main", sessionIds: [] })).toEqual([]);
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
    expect(await listMemorySessionTombstones({ agentId: "main" })).toEqual([
      { sessionId: "session-1", agentId: "main", reason: "forgotten", createdAt: 1_000 },
      { sessionId: "session-2", agentId: "main", reason: "forgotten", createdAt: 1_000 },
    ]);
    expect(
      await listMemorySessionTombstones({ agentId: "main", sessionIds: ["session-2"] }),
    ).toEqual([{ sessionId: "session-2", agentId: "main", reason: "forgotten", createdAt: 1_000 }]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
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
    expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(original);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const calibration = "UPDATE memory_entry_origins SET observed_at = observed_at WHERE 0";
    const readCalibration = "SELECT entry_key FROM memory_entry_origins WHERE 0";
    const observation = observeHostDataSql();
    try {
      db.prepare(calibration).run();
      db.prepare(readCalibration).all();
      expect(observation.queries).toContain(calibration);
      expect(observation.queries).toContain(readCalibration);
      observation.queries.length = 0;
      const rollback = await reserveMemoryEntryOrigins({
        agentIds: ["main"],
        previousMemory: `${buildPromotionMarker("prior")}\n${priorEntry}\n`,
        operations: [{ candidateKey: "candidate", action: "merged", priorEntries: [priorEntry] }],
      });
      expect(await listMemoryEntryOrigins({ agentId: "main", entryKeys: ["candidate"] })).toEqual([
        ...prior.map((entry) => origin("candidate", entry.sessionId)),
        existing,
      ]);

      await rollback();

      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(original);
      expect(
        observation.queries.filter((sql) =>
          /\b(?:from|insert\s+into|update|delete\s+from)\s+"?memory_(?:entry_origins|session_tombstones)\b/iu.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
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
      expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(
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
    const before = await listMemoryEntryOrigins({ agentId: "main" });
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
    const pathname = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.rename(pathname, `${pathname}.original`);
    await fs.copyFile(`${pathname}.original`, pathname);

    const [outcome] = await Promise.allSettled([rollback()]);
    expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(before);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { message: "Agent database target changed before write admission" },
    });
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
      expect(
        (await listMemoryEntryOrigins({ agentId: "main" })).map((entry) => entry.entryKey),
      ).toEqual(["current", "diary", "indexed", "shared", "staged"]);

      await save(["current"], 10_000);

      expect(await readMemoryPreimages(workspaceDir)).toHaveLength(8);
      expect(
        (await listMemoryEntryOrigins({ agentId: "main" })).map((entry) => entry.entryKey),
      ).toEqual(["current", "diary", "indexed", "staged"]);
      await fs.unlink(diaryPath);
      const observation = observeHostDataSql();
      const calibration = "SELECT text FROM memory_index_chunks WHERE 0";
      try {
        db.prepare(calibration).all();
        expect(observation.queries).toContain(calibration);
        observation.queries.length = 0;
        await pruneMemoryEntryOrigins({
          workspaceDir,
          agentIds: ["main"],
          entryKeys: ["diary"],
          retainedEntryKeys,
        });
        expect(await listMemoryEntryOrigins({ agentId: "main", entryKeys: ["diary"] })).toEqual([]);
        expect(
          observation.queries.filter((sql) =>
            /\bfrom\s+"?memory_(?:entry_origins|index_chunks)\b/iu.test(sql),
          ),
        ).toEqual([]);
      } finally {
        observation.restore();
      }
    },
  );

  it("records exact session identity when a transcript recall candidate is first produced", async () => {
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    seedMemoryForgetTombstones({
      agentId: "main",
      sessionIds: ["already-forgotten"],
      createdAt: 999,
    });
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [origin("calibration", "calibration-session")],
    });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const calibration = "UPDATE memory_entry_origins SET observed_at = observed_at WHERE 0";
    const readCalibration = "SELECT entry_key FROM memory_entry_origins WHERE 0";
    const observation = observeHostDataSql();
    try {
      db.prepare(calibration).run();
      db.prepare(readCalibration).all();
      expect(observation.queries).toContain(calibration);
      expect(observation.queries).toContain(readCalibration);
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
          /\b(?:from|insert\s+into|update|delete\s+from)\s+"?memory_(?:entry_origins|session_tombstones)\b/iu.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }

    expect(await listMemoryEntryOrigins({ agentId: "main", sessionIds: ["session-1"] })).toEqual([
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
