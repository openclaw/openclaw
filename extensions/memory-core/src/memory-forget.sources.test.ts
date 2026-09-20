import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  pruneMemoryEntryOrigins,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

describe("memory forget source removal", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it.each(["removed", "new mixed contributor"] as const)(
    "keeps selected file provenance when another workspace leaves lineage %s during planning",
    async (change) => {
      await seedMemoryForgetSession("target");
      await seedMemoryForgetSession("survivor");
      const selected = {
        entryKey: "selected-entry",
        agentId: "main",
        sessionId: "target",
        sessionKey: null,
        originClass: "owner" as const,
        observedAt: 1,
      };
      const survivor = { ...selected, entryKey: "survivor-entry", sessionId: "survivor" };
      recordMemoryEntryOrigins({ agentId: "main", origins: [selected, survivor] });
      const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
      const retained =
        "<!-- openclaw-memory-promotion:survivor-entry -->\n- Retained amber detail.\n";
      await fs.writeFile(
        memoryPath,
        "<!-- openclaw-memory-promotion:selected-entry -->\n- Selected violet detail.\n" + retained,
      );
      const otherWorkspace = path.join(fixture.stateDir, "other-workspace");
      await fs.mkdir(otherWorkspace);
      const planning = createDeferred<void>();
      const resume = createDeferred<void>();
      const list = storage.listMemoryFiles;
      const planningSpy = vi
        .spyOn(storage, "listMemoryFiles")
        .mockImplementationOnce(async (...args) => {
          const files = await list(...args);
          planning.resolve();
          await resume.promise;
          return files;
        });
      const forgetting = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sessionIds: ["target"],
      });
      void forgetting.catch(() => undefined);
      try {
        await Promise.race([
          planning.promise,
          forgetting.then(() => {
            throw new Error("Forget completed before its actual file-planning boundary");
          }),
        ]);
        await withMemoryWorkspaceLock(otherWorkspace, async () => {
          if (change === "removed") {
            await pruneMemoryEntryOrigins({
              workspaceDir: otherWorkspace,
              agentIds: ["main"],
              entryKeys: [selected.entryKey],
              retainedEntryKeys: new Set(),
            });
            expect(
              listMemoryEntryOrigins({ agentId: "main", entryKeys: [selected.entryKey] }),
            ).toEqual([]);
          } else {
            recordMemoryEntryOrigins({
              agentId: "main",
              origins: [{ ...selected, sessionId: "survivor" }],
            });
          }
        });
        resume.resolve();
        const report = await forgetting;
        const durable = {
          entryKeys: report.entryKeys,
          mixedLineageEntryKeys: report.mixedLineageEntryKeys,
          untargetableEntryKeys: report.untargetableEntryKeys,
          memory: await fs.readFile(memoryPath, "utf8"),
          origins: listMemoryEntryOrigins({ agentId: "main" }),
          tombstones: listMemorySessionTombstones({ agentId: "main" }).map(
            ({ sessionId }) => sessionId,
          ),
        };
        expect(durable).toEqual({
          entryKeys: [selected.entryKey],
          mixedLineageEntryKeys: change === "new mixed contributor" ? [selected.entryKey] : [],
          untargetableEntryKeys: [],
          memory: retained,
          origins: [survivor],
          tombstones: ["target"],
        });
      } finally {
        resume.resolve();
        planningSpy.mockRestore();
        await Promise.allSettled([forgetting]);
      }
    },
  );

  it("refuses a retired borrowed handle without writing to its successor after vector loading", async () => {
    await seedMemoryForgetSession("target");
    const origin = {
      entryKey: "selected-entry",
      agentId: "main",
      sessionId: "target",
      sessionKey: null,
      originClass: "owner" as const,
      observedAt: 1,
    };
    recordMemoryEntryOrigins({ agentId: "main", origins: [origin] });
    const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
    const content =
      "<!-- openclaw-memory-promotion:selected-entry -->\n- Selected violet detail.\n";
    await fs.writeFile(memoryPath, content);
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    const load = storage.loadSqliteVecExtension;
    const loaded = await load({ db });
    expect(loaded.ok).toBe(true);
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('selected-snapshot', 'MEMORY.md', 'memory', 1, 2, 'fixture', 'test', ?, '[1,0]', 1)`).run(
      content,
    );
    db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
      "selected-snapshot",
      new Float32Array([1, 0]),
    );
    const nativeLoaded = createDeferred<void>();
    const resume = createDeferred<void>();
    let intercepted = false;
    const loadSpy = vi
      .spyOn(storage, "loadSqliteVecExtension")
      .mockImplementation(async (params) => {
        const result = await load(params);
        if (params.db === db && !intercepted) {
          if (!result.ok) {
            throw new Error(
              `Real borrowed-handle vector load failed: ${result.error ?? "unknown"}`,
            );
          }
          intercepted = true;
          nativeLoaded.resolve();
          await resume.promise;
        }
        return result;
      });
    const forgetting = forgetMemoryEntries({
      cfg: fixture.cfg,
      agentId: "main",
      sessionIds: ["target"],
    });
    const settled = forgetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const readDurable = async (database: DatabaseSync) => ({
      memory: await fs.readFile(memoryPath, "utf8"),
      origins: listMemoryEntryOrigins({ agentId: "main" }),
      tombstones: listMemorySessionTombstones({ agentId: "main" }),
      chunks: database.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
      vectors: database.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all(),
      revision: database.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
    });
    try {
      await Promise.race([
        nativeLoaded.promise,
        settled.then(() => {
          throw new Error("Forget settled before its real borrowed-handle vector load completed");
        }),
      ]);
      // Explicit canonical disposal revokes even a live borrow; eviction would retain it.
      closeOpenClawAgentDatabasesForTest(fixture.stateDir);
      expect(db.isOpen).toBe(false);
      const successor = openOpenClawAgentDatabase({ agentId: "main" }).db;
      // Matcher deep-equality diagnostics cannot inspect a closed native handle.
      expect(successor === db).toBe(false);
      const successorLoaded = await load({ db: successor });
      expect(successorLoaded.ok).toBe(true);
      const before = await readDurable(successor);
      resume.resolve();
      const outcome = await settled;
      const after = await readDurable(successor);
      expect.soft(outcome).toMatchObject({
        ok: false,
        error: { message: "Borrowed agent database closed or changed before write admission" },
      });
      expect(after).toEqual(before);
      expect(after.tombstones).toEqual([]);
      expect(after.origins).toEqual([origin]);
      expect(after.memory).toBe(content);
    } finally {
      resume.resolve();
      loadSpy.mockRestore();
      await Promise.allSettled([forgetting]);
      await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
    }
  });

  it.each([1, 32])(
    "forgets %d sessions with bounded writes and preserves other sources",
    async (sessionCount) => {
      const { cfg } = fixture;
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      const insertSource = db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 1, 1)",
      );
      const insertChunk = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'sessions', 1, 1, 'fixture-hash', 'test', 'forget', '[]', 1)`);
      const provenance = db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'agent', 'interactive', 1)`);
      const sessionIds = Array.from({ length: sessionCount }, (_, index) =>
        sessionCount === 1 ? "target" : `target-${index}`,
      );
      const paths = Array.from(
        { length: 32 },
        (_, index) =>
          `sessions/main/${sessionIds[index % sessionCount]!}.jsonl.deleted.2026-08-25T10-00-00.${String(index).padStart(3, "0")}Z.zst`,
      );
      for (const [index, sourcePath] of paths.entries()) {
        insertSource.run(sourcePath, "sessions", "remove");
        insertChunk.run(`chunk-${index}`, sourcePath);
        provenance.run(`chunk-${index}`);
      }
      insertSource.run(paths[0]!, "memory", "keep-memory");
      insertSource.run("sessions/main/survivor.jsonl", "sessions", "keep-session");
      const survivors = db
        .prepare("SELECT * FROM memory_index_sources WHERE hash != 'remove' ORDER BY id")
        .all();
      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds,
        dryRun: true,
      });
      expect(preview.artifacts.indexSources).toBe(32);
      expect(db.prepare("SELECT count(*) AS count FROM memory_index_sources").get()).toEqual({
        count: 34,
      });
      const prepare = db.prepare.bind(db);
      let sourceDeletes = 0;
      let tombstoneInserts = 0;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        const sourceDelete = sql.startsWith('delete from "memory_index_sources"');
        const tombstoneInsert = sql.startsWith('insert into "memory_session_tombstones"');
        if (sourceDelete || tombstoneInsert) {
          // Preserve positional and named bindings at the native receiver boundary.
          statement.run = new Proxy(statement.run.bind(statement), {
            apply(run, receiver, args) {
              if (sourceDelete) {
                sourceDeletes += 1;
              } else {
                tombstoneInserts += 1;
              }
              return Reflect.apply(run, receiver, args);
            },
          });
        }
        return statement;
      });
      try {
        const result = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds });
        expect(result).toEqual({ ...preview, dryRun: false });
        expect(db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all()).toEqual(
          survivors,
        );
        expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
        expect(listMemorySessionTombstones({ agentId: "main" })).toMatchObject(
          sessionIds.toSorted().map((sessionId) => ({ sessionId, reason: "forgotten" })),
        );
        expect(sourceDeletes).toBeGreaterThan(0);
        expect(sourceDeletes).toBeLessThanOrEqual(2);
        expect(tombstoneInserts).toBeGreaterThan(0);
        expect(tombstoneInserts).toBeLessThanOrEqual(2);
      } finally {
        prepareSpy.mockRestore();
      }
    },
  );

  it.each(["ABORT", "FAIL"])(
    "keeps the index intact when admission fails with %s",
    async (failure) => {
      const { cfg } = fixture;
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      const sessionIds = Array.from({ length: 130 }, (_, index) => `target-${index}`);
      db.prepare(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('sessions/main/target-0.jsonl', 'sessions', 'keep-until-admitted', 1, 1)`).run();
      db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('target-chunk', 'sessions/main/target-0.jsonl', 'sessions', 1, 1, 'hash', 'test', 'forget', '[]', 1)`).run();
      db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at)
      VALUES ('target-chunk', 'agent', 'interactive', 1)`).run();
      const sources = db.prepare("SELECT * FROM memory_index_sources").all();
      const chunks = db.prepare("SELECT * FROM memory_index_chunks").all();
      const revision = db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
      db.exec(`CREATE TEMP TRIGGER fail_forget_admission BEFORE INSERT ON memory_session_tombstones
      WHEN NEW.session_id = 'target-129' BEGIN SELECT RAISE(${failure}, 'synthetic admission failure'); END`);
      await expect(forgetMemoryEntries({ cfg, agentId: "main", sessionIds })).rejects.toThrow(
        "synthetic admission failure",
      );
      expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual(sources);
      expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual(chunks);
      expect(db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual(
        revision,
      );
      db.exec("DROP TRIGGER fail_forget_admission");
      const result = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds });
      expect(result.artifacts.indexSources).toBe(1);
      expect(result.artifacts.indexChunks).toBe(1);
      expect(listMemorySessionTombstones({ agentId: "main" })).toHaveLength(130);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
    },
  );
});
