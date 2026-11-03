#!/usr/bin/env node
// Profile the production keyword SQL on the deterministic PGSEARCHPATH corpus.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hash, vocabulary } from "./lib/memory-search-fixture.mjs";

const { values } = parseArgs({
  options: {
    connection: { type: "string" },
    out: { type: "string" },
    chunks: { type: "string", default: "20000" },
    reference: { type: "string" },
    rounds: { type: "string", default: "5" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/bench-memory-keyword.mjs
  --connection <isolated PG URL> --out <new directory> [--chunks 20000|50000]
  [--reference <previous result.json>] [--rounds 5]

Creates a disposable schema and SQLite database, reuses PGSEARCHPATH text and queries,
records production SQL, compares 256 query results and EXPLAIN plans, then runs warm
counterbalanced SQL timing rounds. Reference SQL is executed only from trusted local
benchmark output. No model or embedding service is called. Removes its databases.`);
  process.exit(0);
}
const count = Number(values.chunks),
  rounds = Number(values.rounds);
if (
  !values.connection ||
  !values.out ||
  ![20000, 50000].includes(count) ||
  !Number.isInteger(rounds) ||
  rounds < 5
) {
  throw new Error(
    "Require --connection, a new --out directory, --chunks 20000|50000, and >=5 rounds",
  );
}
const root = process.cwd(),
  out = path.resolve(values.out);
fs.mkdirSync(out);
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const { Client } = createRequire(path.join(root, "package.json"))("pg");
const { openNodeSqliteDatabase } = await load("src/infra/node-sqlite.ts");
const { openEngineStore } = await load("src/infra/database-engine/open.ts");
const { installDatabaseProcessRole } = await load("src/infra/database-engine/admission-scope.ts");
const { memoryTextSearchSchema } = await load(
  "extensions/memory-core/src/memory/manager-search-schema.ts",
);
const { searchPostgresMemoryKeyword } = await load(
  "extensions/memory-core/src/memory/manager-search-postgres.ts",
);
const { searchKeywordWithFallback } = await load(
  "extensions/memory-core/src/memory/manager-search.ts",
);
installDatabaseProcessRole("cli-oneshot");
const ddl = fs.readFileSync(
  path.join(root, "src/state/postgres-schema.generated/agent.postgres.sql"),
  "utf8",
);
const memoryDDL = [
  ...ddl.matchAll(/CREATE TABLE "memory_[\s\S]*?\n\);/g),
  ...ddl.matchAll(/CREATE (?:UNIQUE )?INDEX [^\n]+ ON "memory_[^\n]+;/g),
  ...ddl.matchAll(/ALTER TABLE "memory_[^\n]+;/g),
]
  .map((m) => m[0])
  .join("\n");
const anchor = openNodeSqliteDatabase(path.join(out, "anchor.sqlite"));
const sqlite = openNodeSqliteDatabase(path.join(out, "comparison.sqlite"));
let db, client, namespace;
const result = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  chunks: count,
  rounds,
  node: process.version,
  load: os.loadavg(),
  queries: [],
  timings: [],
  plans: [],
};
const save = () => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
try {
  db = openEngineStore({
    anchor,
    input: { connection: values.connection, schemaPrefix: "pgkeyword" },
    schema: {
      id: "memory",
      version: 1,
      postgres: memoryDDL,
      sqlite: "",
      search: memoryTextSearchSchema("unicode61"),
    },
    openSqlite() {
      throw new Error("PostgreSQL required");
    },
    prepareAnchor() {},
    inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
  });
  namespace = db.prepare("SELECT current_schema() AS name").get().name;
  result.namespace = namespace;
  client = new Client({ connectionString: values.connection });
  await client.connect();
  await client.query(`SET search_path TO "${namespace}", public`);
  sqlite.exec(`CREATE TABLE memory_index_chunks(id TEXT PRIMARY KEY,path TEXT,source TEXT,start_line INT,end_line INT,text TEXT);
    CREATE INDEX idx_memory_index_chunks_path_source ON memory_index_chunks(path,source);
    CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(id UNINDEXED,path UNINDEXED,source UNINDEXED,start_line UNINDEXED,end_line UNINDEXED,text,tokenize='unicode61');
    CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(path,source UNINDEXED,tokenize='unicode61');`);
  const put = sqlite.prepare("INSERT INTO memory_index_chunks VALUES(?,?,?,?,?,?)");
  sqlite.exec("BEGIN");
  for (let first = 0; first < count; first += 500) {
    const rows = Array.from({ length: Math.min(500, count - first) }, (_, offset) => {
      const i = first + offset,
        line = (i % 100) + 1;
      const text = (
        `PGLIVE6_FACT_${String(i).padStart(5, "0")}: ` +
        Array.from(
          { length: 200 },
          (_word, j) => vocabulary[(i * 7 + j * 11) % 32] + (j % 9 === 0 ? `-${i}-${j}` : ""),
        ).join(" ")
      ).slice(0, 1599);
      const pathname = `memory/facts-${String(Math.floor(i / 100) * 100).padStart(5, "0")}.md`;
      const id = hash(`memory:${pathname}:${line}:${line}:${hash(text)}:fixture`);
      put.run(id, pathname, "memory", line, line, text);
      return { id, path: pathname, line, text };
    });
    await client.query(
      `INSERT INTO memory_index_chunks(id,path,source,start_line,end_line,hash,model,text,embedding,updated_at)
      SELECT id,path,'memory',line,line,id,'fixture',text,''::bytea,100 FROM json_to_recordset($1::json) AS r(id text,path text,line int,text text)`,
      [JSON.stringify(rows)],
    );
  }
  sqlite.exec(
    "INSERT INTO memory_index_chunks_fts SELECT * FROM memory_index_chunks; INSERT INTO memory_index_paths_fts SELECT DISTINCT path,source FROM memory_index_chunks; COMMIT; ANALYZE;",
  );
  await client.query(
    "INSERT INTO memory_index_sources(path,source,hash,mtime,size) SELECT DISTINCT path,'memory',path,100,159900 FROM memory_index_chunks",
  );
  for (const table of ["memory_index_chunks", "memory_index_sources"]) {
    await client.query(`VACUUM ANALYZE ${table}`);
  }
  result.settings = (
    await client.query(
      "SELECT name,setting FROM pg_settings WHERE name IN ('work_mem','shared_buffers','max_parallel_workers_per_gather','jit','random_page_cost')",
    )
  ).rows;
  const queries = [
    ...Array.from({ length: 100 }, (_, i) => [
      "common-fallback",
      Array.from({ length: 4 }, (_word, j) => vocabulary[(i * 3 + j * 7) % 32]).join(" ") +
        ` query ${i}`,
    ]),
    ...Array.from({ length: 40 }, (_, i) => [
      "common-strict",
      Array.from({ length: 1 + (i % 5) }, (_word, j) => vocabulary[(i * 3 + j * 7) % 32]).join(" "),
    ]),
    ...Array.from({ length: 60 }, (_, i) => [
      "rare-strict",
      String((i * 337 + 123) % count).padStart(5, "0"),
    ]),
    ...Array.from({ length: 40 }, (_, i) => [
      "rare-fallback",
      `${String((i * 659 + 127) % count).padStart(5, "0")} impossibleterm`,
    ]),
    ...Array.from({ length: 16 }, (_, i) => [
      "path",
      `memory/facts-${String(i * 100).padStart(5, "0")}.md`,
    ]),
  ];
  const reference = values.reference
    ? JSON.parse(fs.readFileSync(values.reference, "utf8"))
    : undefined;
  if (reference && (reference.chunks !== count || reference.queries.length !== queries.length)) {
    throw new Error("Reference workload differs");
  }
  for (const [index, [kind, query]] of queries.entries()) {
    const common = {
      query,
      limit: 10,
      snippetMaxChars: 700,
      ftsTokenizer: "unicode61",
      sourceFilter: { sql: " AND source IN (?)", params: ["memory"] },
    };
    const input = {
      body: { ...common, ftsTable: "memory_index_chunks_fts" },
      path: { ...common, pathFtsTable: "memory_index_paths_fts" },
    };
    const captured = [],
      original = db.query;
    db.query = (sql, binds) => {
      captured.push({ sql, binds });
      return { rows: [], columns: [], rowCount: 0 };
    };
    try {
      await searchPostgresMemoryKeyword(db, input);
    } finally {
      db.query = original;
    }
    if (captured.length !== 1) {
      throw new Error("Expected one keyword statement");
    }
    const current = captured[0],
      old = reference?.queries[index]?.current;
    if (reference && reference.queries[index].query !== query) {
      throw new Error("Reference query differs");
    }
    const baseline = old
      ? { ...old, sql: old.sql.replaceAll(reference.namespace, namespace) }
      : undefined;
    const sqliteRows = await searchKeywordWithFallback({ db: sqlite, ...input });
    if (sqliteRows.body.error || sqliteRows.path.error) {
      throw new Error(JSON.stringify(sqliteRows));
    }
    const row = { index, kind, query, current, baseline, sqlite: sqliteRows };
    for (const [name, statement] of [
      ["baseline", baseline],
      ["current", current],
    ]) {
      if (statement) {
        row[name + "Rows"] = (await client.query(statement.sql, statement.binds)).rows;
      }
    }
    result.queries.push(row);
    if ([0, 100, 140, 200, 240].includes(index)) {
      result.plans.push({
        index,
        plan: (
          await client.query(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + current.sql,
            current.binds,
          )
        ).rows,
      });
    }
  }
  save();
  for (let round = -1; round < rounds; round++) {
    for (const row of result.queries) {
      for (const name of (round + row.index) % 2
        ? ["current", "baseline"]
        : ["baseline", "current"]) {
        const statement = row[name];
        if (!statement) {
          continue;
        }
        const start = performance.now();
        await client.query(statement.sql, statement.binds);
        if (round >= 0) {
          result.timings.push({
            round,
            index: row.index,
            kind: row.kind,
            name,
            ms: performance.now() - start,
          });
        }
      }
    }
    save();
    console.log(`Completed round ${round + 1}/${rounds}`);
  }
  const percentile = (samples, p) =>
    samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
  const overlap = (expected, current) =>
    expected.length
      ? expected.filter((id) => current.includes(id)).length / expected.length
      : Number(current.length === 0);
  const ids = (rows) => rows.slice(0, 10).map((row) => row.id);
  result.summary = [...new Set(queries.map(([kind]) => kind))].map((kind) => {
    const rows = result.queries.filter((row) => row.kind === kind);
    const mean = (fn) => rows.reduce((sum, row) => sum + fn(row), 0) / rows.length;
    return {
      kind,
      queries: rows.length,
      overlapPg: reference
        ? mean((row) => overlap(ids(row.baselineRows), ids(row.currentRows)))
        : undefined,
      overlapSqlite: mean((row) =>
        overlap(ids([...row.sqlite.body.rows, ...row.sqlite.path.rows]), ids(row.currentRows)),
      ),
      identical: reference
        ? rows.every((row) => JSON.stringify(row.baselineRows) === JSON.stringify(row.currentRows))
        : undefined,
      timings: Object.fromEntries(
        ["baseline", "current"].map((name) => {
          const samples = result.timings
            .filter((row) => row.kind === kind && row.name === name)
            .map((row) => row.ms);
          return [
            name,
            { n: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
          ];
        }),
      ),
    };
  });
  save();
  console.log(JSON.stringify(result.summary, null, 2));
} finally {
  if (client) {
    if (namespace) {
      await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    }
    await client.end();
  }
  db?.close();
  anchor.close();
  sqlite.close();
  for (const name of ["anchor.sqlite", "comparison.sqlite"]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(out, name + suffix), { force: true });
    }
  }
}
