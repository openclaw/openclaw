import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
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
const numberedId = (index: number) => String(index).padStart(2, "0");

function recallWriter(db: DatabaseSync) {
  const insertChunk = db.prepare(`INSERT INTO memory_index_chunks
    (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, 'm', ?, X'', 2)`);
  const insertMetadata = db.prepare(`INSERT INTO ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE}
    (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)`);
  const insertProvenance = db.prepare(`INSERT INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}
    (chunk_id, origin_class, session_kind, observed_at) VALUES (?, ?, 'interactive', 2)`);
  return {
    insertChunk,
    insertMetadata,
    insertProvenance,
    add(
      this: void,
      id: string,
      text: string,
      importance: number,
      project: string | null,
      origin = "owner",
      triggers: string | null = "recall",
    ) {
      insertChunk.run(id, "MEMORY.md", 1, 1, "h", text);
      insertMetadata.run(id, importance, triggers, project);
      insertProvenance.run(id, origin);
    },
  };
}

it("preserves exact project eligibility through selective candidate reads", () => {
  using db = new DatabaseSync(":memory:");
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
  const { add } = recallWriter(db);
  for (const [index, project] of projects.entries()) {
    const id = numberedId(index);
    add(id, `fact ${id}`, 1, project);
  }
  expect(readCuratedMemoryTriggerCandidates(db, 64).map((row) => row.id)).toEqual(
    projects.flatMap((_, index) => (index === 7 || index === 8 ? [] : numberedId(index))),
  );
  for (let index = 0; index < 64; index += 1) {
    const id = `unrelated-${index}`;
    add(id, "higher-ranked unrelated fact", 10, `unrelated-project/${index}`);
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
      for (const projectOnly of [false, true]) {
        const read = projectOnly
          ? readCuratedProjectMemoryCandidates
          : readCuratedMemoryTriggerCandidates;
        const eligible = projectOnly ? expected.filter((index) => index !== 0) : expected;
        expect(
          read(db, limit, active).map((row) => row.id),
          JSON.stringify({ active, limit, projectOnly }),
        ).toEqual(eligible.slice(0, limit).map(numberedId));
      }
    }
  }
});

it.each<[string, string | null, number, number, number]>([
  ["project", "project/current", 2, 65, 128],
  ["global trigger", null, 1, 1, 1],
])(
  "bounds fetched bodies when unrelated projects precede a %s candidate",
  (_scope, projectKey, maxSelects, maxRows, maxBodyMultiples) => {
    using db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    const body = "foreign fact ".repeat(320);
    const { add } = recallWriter(db);
    for (let index = 0; index < 2_000; index += 1) {
      const id = `foreign-${index}`;
      add(id, body, 10, `other/${index}`);
    }
    add("selected", "the selected fact", 1, projectKey);

    const reads = trackSqliteStatementExecutions(db, ["candidates"], (sql) =>
      sql.startsWith("select") && sql.includes('from "memory_index_chunks"') ? "candidates" : null,
    );
    try {
      const results =
        projectKey === null
          ? readCuratedMemoryTriggerCandidates(db, 1, [])
          : readCuratedProjectMemoryCandidates(db, 1, [projectKey]);
      expect(results).toMatchObject([
        { id: "selected", text: "the selected fact", project_key: projectKey },
      ]);
      expect(reads.counts.candidates).toBeLessThanOrEqual(maxSelects);
      expect(reads.rowCounts.candidates).toBeLessThanOrEqual(maxRows);
      // The shared tracker counts all returned text, including metadata.
      expect(reads.textBytes.candidates).toBeGreaterThanOrEqual(
        Buffer.byteLength("the selected fact"),
      );
      expect(reads.textBytes.candidates).toBeLessThan(Buffer.byteLength(body) * maxBodyMultiples);
    } finally {
      reads.restore();
    }
  },
);

it("stores recall metadata in a rollback-safe additive table", () => {
  using db = new DatabaseSync(":memory:");
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
      .map((row) => row.name),
  ).toEqual(
    "chunk_rowid id path source start_line end_line hash model text embedding updated_at".split(
      " ",
    ),
  );
  const { add, insertChunk, insertMetadata, insertProvenance } = recallWriter(db);
  const project = "github.com/openclaw/openclaw";
  const projectCandidates = (limit: number) =>
    readCuratedProjectMemoryCandidates(db, limit, [project]);

  insertChunk.run("good", "MEMORY.md", 1, 1, "h", "t");
  insertProvenance.run("good", "owner");
  insertChunk.run("neutral", "MEMORY.md", 2, 2, "neutral", "neutral");
  expect(() => insertMetadata.run("good", 11, null, null)).toThrow();
  insertMetadata.run("good", 9, "when flying", project);
  const metadata = readMemoryRecallMetadata(db, ["neutral", "good", "good", "unknown"]);
  expect([...metadata.keys()].toSorted()).toEqual(["good", "neutral"]);
  expect(metadata.get("neutral")).toEqual({
    id: "neutral",
    importance: null,
    triggers: null,
    project_key: null,
  });
  const good = {
    id: "good",
    importance: 9,
    triggers: "when flying",
    project_key: project,
  };
  expect(metadata.get("good")).toEqual({
    ...good,
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 2 },
  });
  expect(readCuratedMemoryTriggerCandidates(db, 10)).toEqual([
    {
      ...good,
      path: "MEMORY.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      text: "t",
      origin_class: "owner",
      session_kind: "interactive",
      observed_at: 2,
      supersedes_key: null,
    },
  ]);

  for (let index = 0; index < 80; index += 1) {
    const id = `daily-${String(index).padStart(3, "0")}`;
    const dailyPath = `memory/2026-07-${String(index + 1).padStart(3, "0")}.md`;
    insertChunk.run(id, dailyPath, 1, 1, id, "daily");
    insertMetadata.run(id, null, null, project);
  }
  expect(projectCandidates(1)).toEqual([expect.objectContaining({ id: "good", importance: 9 })]);

  for (let index = 0; index < 64; index += 1) {
    add(`bootstrap-low-${String(index).padStart(3, "0")}`, "low", 1, project, "agent", null);
  }
  add("bootstrap-high", "high", 10, project, "agent", null);
  expect(projectCandidates(48)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "bootstrap-high", importance: 10 })]),
  );

  const foreignProject = "github.com/example/other";
  add("a-foreign", "foreign", 9, foreignProject, "agent", "when flying");
  expect(readCuratedMemoryTriggerCandidates(db, 1, [project])).toEqual([
    expect.objectContaining({ id: "good" }),
  ]);
  expect(readCuratedMemoryTriggerCandidates(db, 1, [])).toEqual([]);

  add("a-fourth", "fourth", 8, "project/d", "agent", "when flying");
  const active = ["project/a", "project/b", "project/c", "project/d"];
  expect(readCuratedMemoryTriggerCandidates(db, 1, active)[0]).toMatchObject({
    id: "a-fourth",
    project_key: "project/d",
  });

  add("untrusted", "untrusted", 10, project, "untrusted", "when flying");
  insertChunk.run("missing", "MEMORY.md", 5, 5, "h5", "missing");
  insertMetadata.run("missing", 10, "when flying", project);
  const triggerIds = readCuratedMemoryTriggerCandidates(db, 10).map((entry) => entry.id);
  const projectIds = projectCandidates(10).map((entry) => entry.id);
  for (const id of ["untrusted", "missing"]) {
    expect(triggerIds).not.toContain(id);
    expect(projectIds).not.toContain(id);
  }
});
