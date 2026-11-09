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
    "query-plan": { type: "boolean" },
    "plan-base": { type: "string" },
    "plan-module": { type: "string" },
    "plan-worker": { type: "string" },
  },
});
if (values.help) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/bench-memory-keyword.mjs
  --connection <isolated PG URL> --out <new directory> [--chunks 20000|50000]
  [--reference <previous result.json>] [--rounds 5]

Creates a disposable schema and SQLite database, reuses PGSEARCHPATH text and queries,
records production SQL, compares 256 query results and EXPLAIN plans, then runs warm
counterbalanced SQL timing rounds. Reference SQL is executed only from trusted local
benchmark output. No model or embedding service is called. Removes its databases.

Query planning only (no PostgreSQL connection or database setup):
  --query-plan --rounds 20 --plan-base <frozen keyword-query.ts> --out <new directory>
Runs fresh serial base/head workers per query/tokenizer cell, separating the first
production call after import from 100 warmups and 20,000 measured warm calls.
The base source and current source must belong to this checkout. Run the whole
command under the normal resource owner for complete CPU/wall/RSS accounting.`);
  process.exit(0);
}
// Query planning is a source-loaded production workload, not SQL client timing.
// Use --query-plan --rounds 20 --plan-base <frozen keyword-query.ts> --out <new dir>.
// Each cell runs serial A/B pairs in fresh workers. Cold means the first call
// after import, not filesystem-cold; 100 explicit warmups precede warm timing.
if (values["query-plan"]) {
  const assert = (await import("node:assert/strict")).default;
  const { createHash } = await import("node:crypto");
  const {
    parseBenchmarkInteger,
    runBenchmarkWorker,
    summarizeBenchmarkTimings,
    writeBenchmarkJson,
  } = await import("./lib/benchmark-harness.mts");
  const root = fs.realpathSync(process.cwd());
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const iterations = 20_000;
  const warmup = 100;
  const fixtures = [
    { id: "long-nfc", tokens: ["München"], match: [["München", "Mu\u0308nchen"]], short: [] },
    { id: "long-nfd", tokens: ["Mu\u0308nchen"], match: [["Mu\u0308nchen", "München"]], short: [] },
    { id: "mixed-nfc", tokens: ["fé", "noir"], match: [["noir"]], short: ["fé"] },
    { id: "mixed-nfd", tokens: ["fe\u0301", "noir"], match: [["noir"]], short: ["fe\u0301"] },
    { id: "short-nfc", tokens: ["fé"], match: [], short: ["fé"] },
    { id: "short-nfd", tokens: ["fe\u0301"], match: [], short: ["fe\u0301"] },
    { id: "substring", tokens: ["東京"], match: [], short: ["東京"] },
    { id: "empty", tokens: [], match: [], short: [] },
  ];
  const cells = ["trigram", "unicode61"].flatMap((tokenizer) =>
    fixtures.map((fixture) => ({ id: `${tokenizer}-${fixture.id}`, tokenizer, fixture })),
  );
  const modulePath = (value) => {
    const file = fs.realpathSync(path.resolve(value));
    assert(file.startsWith(root + path.sep), "production source must belong to this checkout");
    return file;
  };
  const current = modulePath(
    values["plan-module"] ?? "extensions/memory-core/src/memory/keyword-query.ts",
  );
  if (values["plan-worker"]) {
    const cell = cells.find((entry) => entry.id === values["plan-worker"]);
    assert(cell, "unknown query-plan cell");
    const { fixture, tokenizer } = cell;
    const groups = tokenizer === "trigram" ? fixture.match : fixture.tokens.map((token) => [token]);
    const clauses = groups.map((forms) =>
      forms.length === 1
        ? { kind: "term", text: forms[0] }
        : { kind: "any", clauses: forms.map((text) => ({ kind: "term", text })) },
    );
    const input = {
      query: fixture.tokens.join(" "),
      ftsTokenizer: tokenizer,
      canonicalVariants: true,
    };
    const inputBytes = JSON.stringify(input);
    const expected = {
      matchQuery: clauses.length ? { kind: "all", clauses } : null,
      substringTerms: tokenizer === "trigram" ? fixture.short : [],
      tokens: fixture.tokens,
    };
    const sourceSHA256 = digest(fs.readFileSync(current));
    const importStarted = performance.now();
    const owner = await import(pathToFileURL(current).href);
    const importMs = performance.now() - importStarted;
    assert.equal(typeof owner.planKeywordSearch, "function");
    const loadBefore = os.loadavg();
    const coldCpu = process.cpuUsage();
    const coldStart = performance.now();
    const coldOutput = owner.planKeywordSearch(input);
    const coldMs = performance.now() - coldStart;
    const coldUsage = process.cpuUsage(coldCpu);
    assert.deepEqual(coldOutput, expected);
    for (let index = 0; index < warmup; index++) {
      owner.planKeywordSearch(input);
    }
    const warmCpu = process.cpuUsage();
    const warmStart = performance.now();
    let output;
    for (let index = 0; index < iterations; index++) {
      output = owner.planKeywordSearch(input);
    }
    const warmMs = performance.now() - warmStart;
    const warmUsage = process.cpuUsage(warmCpu);
    assert.deepEqual(output, expected);
    assert.equal(JSON.stringify(input), inputBytes, "planner mutated the input");
    assert.equal(digest(fs.readFileSync(current)), sourceSHA256, "production source changed");
    const usage = process.resourceUsage();
    const payload = {
      cell: cell.id,
      sourceSHA256,
      inputSHA256: digest(inputBytes),
      outputSHA256: digest(JSON.stringify(output)),
      coldMs,
      coldCpuUs: coldUsage.user + coldUsage.system,
      warmMsPerOp: warmMs / iterations,
      warmCpuUsPerOp: (warmUsage.user + warmUsage.system) / iterations,
      importMs,
      processSnapshotMs: process.uptime() * 1000,
      processSnapshotCpuUs: usage.userCPUTime + usage.systemCPUTime,
      maxRSSKiB: usage.maxRSS,
      loadBefore,
      loadAfter: os.loadavg(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    };
    await new Promise((resolve) => {
      process.stdout.write(`KEYWORD_PLAN ${JSON.stringify(payload)}\n`, resolve);
    });
    process.exit(0);
  }
  assert(values.out && values["plan-base"], "query planning requires --out and --plan-base");
  const rounds = parseBenchmarkInteger(values.rounds, "--rounds", 20, 20);
  const baseline = modulePath(values["plan-base"]);
  const modules = { base: baseline, head: current };
  const seals = Object.fromEntries(
    Object.entries(modules).map(([arm, file]) => [arm, digest(fs.readFileSync(file))]),
  );
  assert.notEqual(seals.base, seals.head, "base and head source blobs must differ");
  const out = path.resolve(values.out);
  fs.mkdirSync(out);
  const report = {
    workloadSHA256: digest(fs.readFileSync(new URL(import.meta.url))),
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSHA256: seals,
    lockSHA256: digest(fs.readFileSync("pnpm-lock.yaml")),
    loaderSHA256: digest(fs.readFileSync("scripts/lib/tsx-cli-shim.mjs")),
    cachePolicy: "maintained TSX disk cache disabled; fresh worker process-local Map retained",
    coldBoundary: "first production call after source import; not filesystem-cold",
    snapshotBoundary:
      "worker process metrics before result emission; outer command metrics must include all setup/output/cleanup",
    rounds,
    iterations,
    warmup,
    status: "running",
    cells: [],
    unrun: cells.map((cell) => cell.id),
  };
  const metrics = [
    "coldMs",
    "coldCpuUs",
    "warmMsPerOp",
    "warmCpuUsPerOp",
    "processSnapshotMs",
    "processSnapshotCpuUs",
    "maxRSSKiB",
  ];
  const save = () => writeBenchmarkJson(report, path.join(out, "result.json"));
  try {
    for (const cell of cells) {
      const samples = { base: [], head: [] };
      const result = { id: cell.id, samples, summaries: {}, rejected: [] };
      report.cells.push(result);
      report.unrun.shift();
      for (let round = 0; round < rounds; round++) {
        for (const arm of ["base", "head"]) {
          report.active = { cell: cell.id, round, arm };
          const sample = runBenchmarkWorker({
            args: [
              "--import",
              "./scripts/tsx.mjs",
              "scripts/bench-memory-keyword.mjs",
              "--query-plan",
              "--plan-worker",
              cell.id,
              "--plan-module",
              modules[arm],
            ],
            label: `${cell.id}-${arm}-${round}`,
            sentinel: "KEYWORD_PLAN ",
            timeoutMs: 30_000,
            validate(value) {
              assert(
                value &&
                  typeof value === "object" &&
                  value.cell === cell.id &&
                  value.sourceSHA256 === seals[arm],
              );
              for (const metric of metrics) {
                assert(Number.isFinite(value[metric]) && value[metric] >= 0, metric);
              }
              assert.match(value.inputSHA256, /^[a-f0-9]{64}$/u);
              assert.match(value.outputSHA256, /^[a-f0-9]{64}$/u);
              assert.equal(value.node, process.version);
              assert.equal(value.platform, process.platform);
              assert.equal(value.arch, process.arch);
              return value;
            },
          });
          samples[arm].push(sample);
          if (arm === "head") {
            const base = samples.base[round];
            assert.equal(sample.inputSHA256, base.inputSHA256);
            assert.equal(sample.outputSHA256, base.outputSHA256);
          }
          save();
        }
      }
      for (const metric of metrics) {
        const base = summarizeBenchmarkTimings(samples.base.map((sample) => sample[metric]));
        const head = summarizeBenchmarkTimings(samples.head.map((sample) => sample[metric]));
        result.summaries[metric] = { base, head };
        for (const percentile of ["p50", "p95"]) {
          assert(base[percentile] > 0, `${cell.id}/${metric}/${percentile}: non-positive baseline`);
          if (head[percentile] >= base[percentile] * 1.2) {
            result.rejected.push(`${metric}/${percentile}`);
          }
        }
      }
      save();
      assert.equal(
        result.rejected.length,
        0,
        `${cell.id}: inclusive 20% cost STOP: ${result.rejected.join(", ")}`,
      );
    }
    delete report.active;
    report.status = "complete";
    save();
  } catch (error) {
    report.status = "hold";
    report.failure = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  }
  await new Promise((resolve) => {
    process.stdout.write(`Query-plan report: ${path.join(out, "result.json")}\n`, resolve);
  });
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
