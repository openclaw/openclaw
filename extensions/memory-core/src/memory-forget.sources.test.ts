import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMemorySessionTombstones } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";

describe("memory forget source removal", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
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
