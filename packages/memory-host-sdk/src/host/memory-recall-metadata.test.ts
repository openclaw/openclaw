import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
} from "./memory-recall-metadata.js";
import { MEMORY_INDEX_CHUNK_PROVENANCE_TABLE } from "./memory-schema-provenance.js";
import {
  ensureMemoryRecallMetadataSchema,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory recall metadata", () => {
  it("preserves exact project eligibility through selective candidate reads", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      const projects = [
        null,
        "",
        " ; \t; ",
        "project/a",
        "project/aa",
        "\ufeffproject/a\u00a0",
        "project/a; project/b",
        "project/a; !invalid-project-annotation",
        "!invalid-project-annotation",
        "project/a; ; project/a",
        "project/\0a",
        "project/🦞",
        "project/'%_\\",
        "project/\\u0000",
        "project/\ud800",
      ];
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, 'MEMORY.md', 1, 1, 'h', 'm', ?, '[]', 2)`,
      );
      const insertMetadata = db.prepare(
        `INSERT INTO memory_index_chunk_recall_metadata
         (chunk_id, importance, triggers, project_key) VALUES (?, ?, 'recall', ?)`,
      );
      const insertProvenance = db.prepare(
        `INSERT INTO memory_index_chunk_provenance
         (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'owner', 'interactive', 2)`,
      );
      for (const [index, project] of projects.entries()) {
        const id = String(index).padStart(2, "0");
        insertChunk.run(id, `fact ${id}`);
        insertMetadata.run(id, 1, project);
        insertProvenance.run(id);
      }
      expect(readCuratedMemoryTriggerCandidates(db, 64).map((row) => row.id)).toEqual(
        projects.flatMap((_, index) =>
          index === 7 || index === 8 ? [] : String(index).padStart(2, "0"),
        ),
      );
      for (let index = 0; index < 64; index += 1) {
        const id = `unrelated-${index}`;
        insertChunk.run(id, "higher-ranked unrelated fact");
        insertMetadata.run(id, 10, `unrelated-project/${index}`);
        insertProvenance.run(id);
      }
      const cases = [
        { active: [], expected: [0] },
        { active: [" \t "], expected: [0] },
        { active: ["project/a"], expected: [0, 3, 5, 9] },
        { active: ["\u2003project/a\u2029", "project/a"], expected: [0, 3, 5, 9] },
        { active: ["project/a", "project/b"], expected: [0, 3, 5, 6, 9] },
        { active: ["project/aa"], expected: [0, 4] },
        { active: ["project/\0a"], expected: [0, 10] },
        { active: ["project/🦞"], expected: [0, 11] },
        { active: ["project/'%_\\"], expected: [0, 12] },
        { active: ["project/\\u0000"], expected: [0, 13] },
        { active: ["project/\ud800"], expected: [0] },
        { active: ["project/\ufffd"], expected: [0, 14] },
        { active: ["!invalid-project-annotation", "project/a"], expected: [0, 3, 5, 9] },
        {
          active: [...Array.from({ length: 64 }, (_, index) => `other/${index}`), "project/a"],
          expected: [0, 3, 5, 9],
        },
      ];
      for (const { active, expected } of cases) {
        for (const limit of [1, 2, 64]) {
          expect(
            readCuratedMemoryTriggerCandidates(db, limit, active).map((row) => row.id),
            JSON.stringify({ active, limit }),
          ).toEqual(expected.slice(0, limit).map((index) => String(index).padStart(2, "0")));
          expect(
            readCuratedProjectMemoryCandidates(db, limit, active).map((row) => row.id),
            JSON.stringify({ active, limit }),
          ).toEqual(
            expected
              .filter((index) => index !== 0)
              .slice(0, limit)
              .map((index) => String(index).padStart(2, "0")),
          );
        }
      }
    } finally {
      db.close();
    }
  });

  it("bounds fetched bodies when unrelated projects precede a curated candidate", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      const body = "foreign fact ".repeat(320);
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, 'MEMORY.md', 1, 1, 'h', 'm', ?, '[]', 2)`,
      );
      const insertMetadata = db.prepare(
        `INSERT INTO memory_index_chunk_recall_metadata
         (chunk_id, importance, triggers, project_key) VALUES (?, ?, 'recall', ?)`,
      );
      const insertProvenance = db.prepare(
        `INSERT INTO memory_index_chunk_provenance
         (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'owner', 'interactive', 2)`,
      );
      for (let index = 0; index < 2_000; index += 1) {
        const id = `foreign-${index}`;
        insertChunk.run(id, body);
        insertMetadata.run(id, 10, `other/${index}`);
        insertProvenance.run(id);
      }
      insertChunk.run("selected", "the selected fact");
      insertMetadata.run("selected", 1, "project/current");
      insertProvenance.run("selected");

      let fetchedBodyBytes = 0;
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...values) {
          for (const row of iterate(...values)) {
            if (typeof row.text === "string") {
              fetchedBodyBytes += Buffer.byteLength(row.text);
            }
            yield row;
          }
          return undefined;
        });
        return statement;
      });
      expect(readCuratedProjectMemoryCandidates(db, 1, ["project/current"])).toEqual([
        expect.objectContaining({ id: "selected", text: "the selected fact" }),
      ]);
      expect(fetchedBodyBytes).toBeLessThan(Buffer.byteLength(body) * 128);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      spy.mockRestore();
    } finally {
      db.close();
    }
  });

  it("stores recall metadata in a rollback-safe additive table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE memory_index_chunks (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
          model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.exec("BEGIN IMMEDIATE");
      ensureMemoryRecallMetadataSchema(db);
      db.exec("ROLLBACK");
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE),
      ).toBeUndefined();

      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('memory_index_chunks') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual([
        "id",
        "path",
        "source",
        "start_line",
        "end_line",
        "hash",
        "model",
        "text",
        "embedding",
        "updated_at",
      ]);
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, 'm', ?, '[]', 2)`,
      );
      const insertMetadata = db.prepare(
        `INSERT INTO ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE}
         (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)`,
      );
      const insertProvenance = db.prepare(
        `INSERT INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}
         (chunk_id, origin_class, session_kind, observed_at)
         VALUES (?, ?, 'interactive', 2)`,
      );

      insertChunk.run("good", "MEMORY.md", 1, 1, "h", "t");
      insertProvenance.run("good", "owner");
      insertChunk.run("neutral", "MEMORY.md", 2, 2, "neutral", "neutral");
      expect(() => insertMetadata.run("good", 11, null, null)).toThrow();
      insertMetadata.run("good", 9, "when flying", "github.com/openclaw/openclaw");
      const metadata = readMemoryRecallMetadata(db, ["neutral", "good", "good", "unknown"]);
      expect([...metadata.keys()].toSorted()).toEqual(["good", "neutral"]);
      expect(metadata.get("neutral")).toEqual({
        id: "neutral",
        importance: null,
        triggers: null,
        project_key: null,
      });
      expect(metadata.get("good")).toEqual({
        id: "good",
        importance: 9,
        triggers: "when flying",
        project_key: "github.com/openclaw/openclaw",
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 2 },
      });
      expect(readCuratedMemoryTriggerCandidates(db, 10)).toEqual([
        {
          id: "good",
          path: "MEMORY.md",
          source: "memory",
          start_line: 1,
          end_line: 1,
          text: "t",
          importance: 9,
          triggers: "when flying",
          project_key: "github.com/openclaw/openclaw",
          origin_class: "owner",
          session_kind: "interactive",
          observed_at: 2,
          supersedes_key: null,
        },
      ]);

      for (let index = 0; index < 80; index += 1) {
        const id = `daily-${String(index).padStart(3, "0")}`;
        insertChunk.run(
          id,
          `memory/2026-07-${String(index + 1).padStart(3, "0")}.md`,
          1,
          1,
          id,
          "daily",
        );
        insertMetadata.run(id, null, null, "github.com/openclaw/openclaw");
      }
      expect(readCuratedProjectMemoryCandidates(db, 1, ["github.com/openclaw/openclaw"])).toEqual([
        expect.objectContaining({ id: "good", importance: 9 }),
      ]);

      for (let index = 0; index < 64; index += 1) {
        const id = `bootstrap-low-${String(index).padStart(3, "0")}`;
        insertChunk.run(id, "MEMORY.md", index + 2, index + 2, id, "low");
        insertProvenance.run(id, "agent");
        insertMetadata.run(id, 1, null, "github.com/openclaw/openclaw");
      }
      insertChunk.run(
        "bootstrap-high",
        "MEMORY.md",
        100,
        100,
        "bootstrap-high",
        "high-priority bootstrap fact",
      );
      insertProvenance.run("bootstrap-high", "agent");
      insertMetadata.run("bootstrap-high", 10, null, "github.com/openclaw/openclaw");
      expect(readCuratedProjectMemoryCandidates(db, 48, ["github.com/openclaw/openclaw"])).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "bootstrap-high", importance: 10 })]),
      );

      insertChunk.run("a-foreign", "MEMORY.md", 2, 2, "h2", "foreign");
      insertProvenance.run("a-foreign", "agent");
      insertMetadata.run("a-foreign", 9, "when flying", "github.com/example/other");
      expect(readCuratedMemoryTriggerCandidates(db, 1, ["github.com/openclaw/openclaw"])).toEqual([
        expect.objectContaining({ id: "good" }),
      ]);
      expect(readCuratedMemoryTriggerCandidates(db, 1, [])).toEqual([]);

      insertChunk.run("a-fourth", "MEMORY.md", 3, 3, "h3", "fourth");
      insertProvenance.run("a-fourth", "agent");
      insertMetadata.run("a-fourth", 8, "when flying", "project/d");
      expect(
        readCuratedMemoryTriggerCandidates(db, 1, [
          "project/a",
          "project/b",
          "project/c",
          "project/d",
        ])[0],
      ).toMatchObject({ id: "a-fourth", project_key: "project/d" });

      insertChunk.run("untrusted", "MEMORY.md", 4, 4, "h4", "untrusted");
      insertProvenance.run("untrusted", "untrusted");
      insertMetadata.run("untrusted", 10, "when flying", "github.com/openclaw/openclaw");
      insertChunk.run("missing", "MEMORY.md", 5, 5, "h5", "missing");
      insertMetadata.run("missing", 10, "when flying", "github.com/openclaw/openclaw");
      const triggerIds = readCuratedMemoryTriggerCandidates(db, 10).map((entry) => entry.id);
      const projectIds = readCuratedProjectMemoryCandidates(db, 10, [
        "github.com/openclaw/openclaw",
      ]).map((entry) => entry.id);
      for (const id of ["untrusted", "missing"]) {
        expect(triggerIds).not.toContain(id);
        expect(projectIds).not.toContain(id);
      }
    } finally {
      db.close();
    }
  });
});
