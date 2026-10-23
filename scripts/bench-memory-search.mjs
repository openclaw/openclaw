#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Exact production memory-search benchmark with deterministic vectors and no provider calls.
// Run with: node --import ./scripts/tsx.mjs scripts/bench-memory-search.mjs --help
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMemorySearchFixture,
  identity,
  embedding,
  hash,
  vocabulary,
} from "./lib/memory-search-fixture.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/bench-memory-search.mjs

Required environment:
  PGMEMSEARCH_CONNECTION   Isolated PostgreSQL database URL; the benchmark creates synthetic state.
  PGMEMSEARCH_OUT          New directory for results, captured SQL, and EXPLAIN plans.

Optional environment:
  PGMEMSEARCH_REPO         Production checkout to import (default: current directory).
  PGMEMSEARCH_CHUNKS       Synthetic chunk count, a multiple of 10 >= 30 (default: 20000).
  PGMEMSEARCH_QUERIES      Paired queries per mode, >= 100 (default: 100).
  PGMEMSEARCH_SOURCE_MODE  candidate (default) or baseline, matching the checkout's ORDER BY.

Runs vector, keyword, and hybrid queries with five warmups per arm and alternating pair order.
Candidate mode runs production alias SQL unchanged; baseline mode runs production distance SQL
unchanged. The other arm changes only ORDER BY and its redundant vector binding.
No embedding service or model is called. Use a task-owned database and a fresh output directory.`);
  process.exit(0);
}
if (args.length) {
  throw new Error(`Unsupported argument: ${args.join(" ")}; use --help`);
}

const ROOT = path.resolve(process.env.PGMEMSEARCH_REPO ?? process.cwd());
const sourceMode = process.env.PGMEMSEARCH_SOURCE_MODE ?? "candidate";
if (!["baseline", "candidate"].includes(sourceMode)) {
  throw new Error("Unsupported source mode");
}
if (!process.env.PGMEMSEARCH_OUT) {
  throw new Error("Set PGMEMSEARCH_OUT to a fresh benchmark output directory");
}
const OUT = path.resolve(process.env.PGMEMSEARCH_OUT);
const connection = process.env.PGMEMSEARCH_CONNECTION;
if (!connection) {
  throw new Error("Set PGMEMSEARCH_CONNECTION to an isolated PostgreSQL database");
}
const count = Number(process.env.PGMEMSEARCH_QUERIES ?? 100),
  warmup = 5;
const n = Number(process.env.PGMEMSEARCH_CHUNKS ?? 20_000);
if (!Number.isInteger(count) || count < 100) {
  throw new Error("Require at least 100 paired queries per mode");
}
if (!Number.isInteger(n) || n < 30 || n % 10 !== 0) {
  throw new Error("Require a chunk count that is a multiple of 10 and at least 30");
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(OUT);
const { sources } = createMemorySearchFixture(n);
const req = createRequire(path.join(ROOT, "package.json"));
const { default: pg } = await import(req.resolve("pg"));
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const { openEngineStore } = await load("src/infra/database-engine/open.ts");
const { installDatabaseProcessRole } = await load("src/infra/database-engine/admission-scope.ts");
const { openNodeSqliteDatabase } = await load("src/infra/node-sqlite.ts");
const { admitStoreSearch } = await load("src/infra/database-engine/adapters.ts");
const { preparePostgresQuery } = await load("src/infra/postgres-sync/protocol.ts");
const { memoryTextSearchSchema, memoryVectorSearchSchema } = await load(
  "extensions/memory-core/src/memory/manager-search-schema.ts",
);
const { memoryChunkRowId } = await load(
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts",
);
const { searchPostgresMemoryVector, searchPostgresMemoryKeyword } = await load(
  "extensions/memory-core/src/memory/manager-search-postgres.ts",
);
const { mergeHybridResults } = await load("extensions/memory-core/src/memory/hybrid.ts");
installDatabaseProcessRole("cli-oneshot");
const save = (name, value) =>
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify(value, null, 2));
const ddl = fs.readFileSync(
  path.join(ROOT, "src/state/postgres-schema.generated/agent.postgres.sql"),
  "utf8",
);
const memoryDDL = [
  ...ddl.matchAll(/CREATE TABLE "memory_[\s\S]*?\n\);/g),
  ...ddl.matchAll(/CREATE (?:UNIQUE )?INDEX [^\n]+ ON "memory_[^\n]+;/g),
  ...ddl.matchAll(/ALTER TABLE "memory_[^\n]+;/g),
]
  .map((m) => m[0])
  .join("\n");
if (!memoryDDL.includes('CREATE TABLE "memory_index_chunks"')) {
  throw new Error("Memory DDL extraction failed");
}
fs.writeFileSync(path.join(OUT, "schema-input.sql"), memoryDDL);
let anchor;
let db;
let client;
const receipt = {
  sourceMode,
  pin: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  n,
  dimensions: 1536,
  queries: count,
  warmup,
  node: process.version,
  startedAt: new Date().toISOString(),
  fixtureHash: hash(sources.map((s) => hash(JSON.stringify(s))).join("\n")),
  schemaHash: hash(memoryDDL),
  benchmarkHash: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  notes: [
    "Deterministic corpus and vectors match the PGMEMSTORE fixture.",
    "Bulk fixture load bypasses only the derived-vector trigger, then validates native projections and restores it before any search.",
    "Candidate reuses selected distance for ordering; eligibility, exact scoring and limits are unchanged.",
    "Every search SQL statement and bindings are captured at production db.query and db.prepare; plans use the production preparePostgresQuery converter.",
    "Hybrid calls both production retrieval owners and the production merge owner; raw component results participate in equality hashes.",
  ],
  warmups: [],
  samples: [],
  boundary: [],
  summaries: {},
  loadBefore: os.loadavg(),
};
save("receipt", receipt);
try {
  anchor = openNodeSqliteDatabase(path.join(OUT, "pg-anchor.sqlite"));
  db = openEngineStore({
    anchor,
    input: { connection, schemaPrefix: "pgmemsearch" },
    schema: { id: "memory", version: 1, postgres: memoryDDL, sqlite: "" },
    openSqlite() {
      throw new Error("PG required");
    },
    prepareAnchor() {},
    inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
  });
  client = new pg.Client({ connectionString: connection });
  await client.connect();
  const namespace = String(db.prepare("SELECT current_schema() AS name").get().name);
  receipt.namespace = namespace;
  const qid = (s) => '"' + s.replaceAll('"', '""') + '"';
  await client.query("SET search_path TO " + qid(namespace) + ", public");
  db.runTransaction(() => {
    admitStoreSearch(db, memoryTextSearchSchema("unicode61"), { extension: "memory.text" });
    admitStoreSearch(db, memoryVectorSearchSchema(1536), { extension: "memory.vector" });
    db.exec("INSERT INTO memory_index_state(id,revision) VALUES (1,0)");
  });
  save("receipt", receipt);
  const loadStart = performance.now();
  await client.query("BEGIN");
  try {
    await client.query(
      "ALTER TABLE memory_index_chunks DISABLE TRIGGER memory_index_chunks_vec_sync",
    );
    for (let s = 0; s < sources.length; s += 10) {
      const group = sources.slice(s, s + 10);
      await client.query(
        `INSERT INTO memory_index_sources(path,source,hash,mtime,size) SELECT path,source,hash,mtime,size FROM jsonb_to_recordset($1::jsonb) AS r(path text,source text,hash text,mtime float8,size bigint)`,
        [
          JSON.stringify(
            group.map((x) => ({
              path: x.entry.path,
              source: x.source,
              hash: x.entry.hash,
              mtime: x.entry.mtimeMs,
              size: x.entry.size,
            })),
          ),
        ],
      );
      const rows = group.flatMap((source) =>
        source.chunks.map((chunk, j) => {
          const vector = source.embeddings[j],
            bytes = Buffer.alloc(vector.length * 8);
          vector.forEach((value, k) => bytes.writeDoubleLE(value, k * 8));
          return {
            id: memoryChunkRowId(source.source, source.entry.path, chunk, source.model),
            path: source.entry.path,
            source: source.source,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            hash: chunk.hash,
            model: source.model,
            text: chunk.text,
            embedding: bytes.toString("hex"),
            updated_at: source.now,
            vector: "[" + vector.map(Math.fround).join(",") + "]",
          };
        }),
      );
      await client.query(
        `WITH r AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(id text,path text,source text,start_line bigint,end_line bigint,hash text,model text,text text,embedding text,updated_at bigint,vector text)), inserted AS (INSERT INTO memory_index_chunks(id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) SELECT id,path,source,start_line,end_line,hash,model,text,decode(embedding,'hex'),updated_at FROM r RETURNING id) INSERT INTO memory_index_chunks_vec(id,embedding) SELECT r.id,r.vector::public.vector FROM r JOIN inserted USING(id)`,
        [JSON.stringify(rows)],
      );
      if (s % 200 === 0) {
        console.log("loaded", Math.min(n, (s + 10) * 10));
      }
    }
    await client.query(
      "ALTER TABLE memory_index_chunks ENABLE TRIGGER memory_index_chunks_vec_sync",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const verification = (
    await client.query(
      `SELECT count(*)::int AS sampled, bool_and(v.embedding = openclaw_vector(c.embedding,1536)) AS exact FROM memory_index_chunks c JOIN memory_index_chunks_vec v USING(id) WHERE c.chunk_rowid % 997 = 0 OR c.chunk_rowid IN (1,$1)`,
      [n],
    )
  ).rows[0];
  const totals = (
    await client.query(
      "SELECT (SELECT count(*)::int FROM memory_index_chunks) AS chunks,(SELECT count(*)::int FROM memory_index_sources) AS sources,(SELECT count(*)::int FROM memory_index_chunks_vec) AS vectors",
    )
  ).rows[0];
  if (
    !verification.exact ||
    totals.chunks !== n ||
    totals.vectors !== n ||
    totals.sources !== n / 10
  ) {
    throw new Error("Fixture verification failed");
  }
  await client.query("ANALYZE memory_index_chunks");
  await client.query("ANALYZE memory_index_chunks_vec");
  await client.query("ANALYZE memory_index_sources");
  receipt.fixture = {
    ms: performance.now() - loadStart,
    verification,
    totals,
    trigger: (
      await client.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgrelid='memory_index_chunks'::regclass AND tgname='memory_index_chunks_vec_sync'",
      )
    ).rows,
  };
  receipt.settings = (
    await client.query(
      "SELECT name,setting FROM pg_settings WHERE name IN ('max_parallel_workers_per_gather','max_parallel_workers','parallel_setup_cost','parallel_tuple_cost','min_parallel_table_scan_size','work_mem','jit','shared_buffers','random_page_cost','seq_page_cost') ORDER BY name",
    )
  ).rows;
  const candidateIds = sources
    .slice(0, 4)
    .flatMap((source) =>
      source.chunks.map((chunk) =>
        memoryChunkRowId(source.source, source.entry.path, chunk, source.model),
      ),
    );
  const excludedSessionPaths = [sources[1].entry.path, sources[2].entry.path];
  // The measured production path never keeps the corpus embeddings in JavaScript.
  sources.length = 0;
  let variant = "baseline",
    active;
  const original = db.query.bind(db),
    originalPrepare = db.prepare.bind(db);
  const rewrite = (sql, parameters) => {
    let text = sql;
    const bindings = [...parameters];
    if (sql.includes(' OPERATOR("public".<=>) ')) {
      const projection = sql.match(
        / OPERATOR\("public"\.<=>\) \$(\d+)::"public"\.vector as "dist"/,
      );
      if (!projection) {
        throw new Error("Vector projection no longer matches the benchmark contract");
      }
      const vectorOrdinal = Number(projection[1]);
      if (sourceMode === "baseline" && variant === "candidate") {
        const order =
          /order by "v"\."embedding" OPERATOR\("public"\.<=>\) \$(\d+)::"public"\.vector, "c"\."id"/;
        const match = sql.match(order);
        if (!match) {
          throw new Error("Alias substitution did not match production order");
        }
        const ordinal = Number(match[1]);
        if (bindings[ordinal - 1] !== bindings[vectorOrdinal - 1]) {
          throw new Error("ORDER BY vector differs from projected vector");
        }
        bindings.splice(ordinal - 1, 1);
        text = sql
          .replace(order, 'order by "dist", "c"."id"')
          .replace(/\$(\d+)/g, (token, n2) =>
            Number(n2) > ordinal ? "$" + (Number(n2) - 1) : token,
          );
      } else if (sourceMode === "candidate" && variant === "baseline") {
        const order = sql.match(/order by "dist", "c"\."id" limit \$(\d+)/);
        if (!order) {
          throw new Error("Baseline substitution did not match production alias");
        }
        const ordinal = Number(order[1]);
        bindings.splice(ordinal - 1, 0, bindings[vectorOrdinal - 1]);
        text = sql
          .replace(/\$(\d+)/g, (token, n2) =>
            Number(n2) >= ordinal ? "$" + (Number(n2) + 1) : token,
          )
          .replace(
            'order by "dist", "c"."id"',
            `order by "v"."embedding" OPERATOR("public".<=>) $${ordinal}::"public".vector, "c"."id"`,
          );
      }
    }
    return { sql: text, parameters: bindings };
  };
  const record = (sql, parameters) =>
    active?.push({
      sql,
      parameters: parameters.map((p) =>
        p instanceof Uint8Array ? { hex: Buffer.from(p).toString("hex") } : p,
      ),
    });
  db.query = (sql, parameters = [], ...rest) => {
    const next = rewrite(sql, parameters);
    record(next.sql, next.parameters);
    return original(next.sql, next.parameters, ...rest);
  };
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return ["get", "all", "run", "iterate"].includes(String(key))
          ? (...parameters) => {
              const next = rewrite(sql, parameters);
              record(next.sql, next.parameters);
              const chosen = next.sql === sql ? target : originalPrepare(next.sql);
              return Reflect.get(chosen, key).apply(chosen, next.parameters);
            }
          : typeof value === "function"
            ? value.bind(target)
            : value;
      },
    });
  };
  const filter = { sql: " AND source IN (?, ?)", params: ["memory", "sessions"] };
  const vquery = (i, overrides = {}) => ({
    providerModel: identity.model,
    sourceFilter: filter,
    queryVec: embedding((i % 20) * 997),
    limit: 10,
    snippetMaxChars: 700,
    ...overrides,
  });
  const kquery = (i) => {
    const query = `${vocabulary[i % 32]} topic${i % 200}`;
    const common = {
      query,
      limit: 20,
      snippetMaxChars: 700,
      ftsTokenizer: "unicode61",
      sourceFilter: filter,
    };
    return {
      body: { ...common, ftsTable: "memory_index_chunks_fts" },
      path: { ...common, pathFtsTable: "memory_index_paths_fts" },
    };
  };
  async function run(mode, i, overrides = {}) {
    active = [];
    const start = performance.now();
    let result;
    try {
      if (mode === "vector") {
        result = await searchPostgresMemoryVector(db, vquery(i, overrides));
      } else if (mode === "keyword") {
        result = await searchPostgresMemoryKeyword(db, kquery(i));
      } else {
        const vector = await searchPostgresMemoryVector(db, vquery(i, overrides));
        const keyword2 = await searchPostgresMemoryKeyword(db, kquery(i));
        const hybrid = await mergeHybridResults({
          vector: vector.map((x) => ({ ...x, vectorScore: x.score })),
          keyword: [...keyword2.body.rows, ...keyword2.path.rows],
          vectorWeight: 0.7,
          textWeight: 0.3,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        });
        result = { vector, keyword: keyword2, hybrid };
      }
      const elapsed = performance.now() - start,
        statements = active;
      const keyword = mode === "keyword" ? result : mode === "hybrid" ? result.keyword : void 0;
      if (keyword && (keyword.body.error || keyword.path.error)) {
        throw new Error(JSON.stringify(keyword));
      }
      if (
        !statements.length &&
        !(Array.isArray(overrides.candidateIds) && !overrides.candidateIds.length)
      ) {
        throw new Error("Missing captured SQL");
      }
      if (
        !Object.keys(overrides).length &&
        ((mode === "vector" && !result.length) ||
          (mode === "keyword" && !result.body.rows.length) ||
          (mode === "hybrid" &&
            (!result.vector.length || !result.keyword.body.rows.length || !result.hybrid.length)))
      ) {
        throw new Error("Empty primary search result");
      }
      return {
        mode,
        i,
        variant,
        ms: elapsed,
        hash: hash(JSON.stringify(result)),
        count: statements.length,
        statements,
      };
    } finally {
      active = void 0;
    }
  }
  async function explain(label, sample) {
    const plans = [];
    for (const statement of sample.statements) {
      if (statement.parameters.some((p) => p && typeof p === "object")) {
        throw new Error("Unexpected binary search binding");
      }
      const native = preparePostgresQuery(statement.sql).sql;
      plans.push({
        sql: native,
        parameters: statement.parameters,
        plan: (
          await client.query(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + native,
            statement.parameters,
          )
        ).rows,
      });
    }
    save("explain-" + label, plans);
  }
  for (const mode of ["vector", "keyword", "hybrid"]) {
    for (let i = 0; i < warmup; i++) {
      const pair = {};
      for (const chosen of ["baseline", "candidate"]) {
        variant = chosen;
        pair[chosen] = await run(mode, i);
        receipt.warmups.push(pair[chosen]);
      }
      if (
        pair.baseline.hash !== pair.candidate.hash ||
        pair.candidate.count > pair.baseline.count
      ) {
        throw new Error("Warmup parity/statement regression " + mode + " " + i);
      }
    }
    for (let i = 0; i < count; i++) {
      const pair = {};
      for (const chosen of i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        variant = chosen;
        pair[chosen] = await run(mode, i);
      }
      if (
        pair.baseline.hash !== pair.candidate.hash ||
        pair.candidate.count > pair.baseline.count
      ) {
        throw new Error("Parity/statement regression " + mode + " " + i);
      }
      receipt.samples.push(pair.baseline, pair.candidate);
      if (i === 0) {
        for (const chosen of ["baseline", "candidate"]) {
          await explain(mode + "-" + chosen, pair[chosen]);
        }
      }
      if (i % 20 === 19) {
        save("receipt", receipt);
        console.log(mode, i + 1, "pairs complete");
      }
    }
  }
  const boundaries = [
    {
      name: "memory",
      overrides: { sourceFilter: { sql: " AND source IN (?)", params: ["memory"] } },
    },
    {
      name: "sessions-excluded",
      overrides: {
        sourceFilter: {
          sql: " AND source IN (?)",
          params: ["sessions"],
          excludedSessionPaths,
        },
      },
    },
    {
      name: "model-alias",
      overrides: { providerModel: "absent-model", providerModelAliases: [identity.model] },
    },
    { name: "candidate-ids", overrides: { candidateIds } },
    { name: "empty-candidates", overrides: { candidateIds: [] } },
    { name: "missing-model", overrides: { providerModel: "absent-model" } },
  ];
  for (const { name, overrides } of boundaries) {
    const pair = {};
    for (const chosen of ["baseline", "candidate"]) {
      variant = chosen;
      pair[chosen] = await run("vector", 7, overrides);
    }
    if (pair.baseline.hash !== pair.candidate.hash || pair.candidate.count > pair.baseline.count) {
      throw new Error("Boundary regression " + name);
    }
    receipt.boundary.push({ name, ...pair });
    if (name !== "empty-candidates") {
      for (const chosen of ["baseline", "candidate"]) {
        await explain("boundary-" + name + "-" + chosen, pair[chosen]);
      }
    }
  }
  const quantile = (values, q) =>
    values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1];
  for (const mode of ["vector", "keyword", "hybrid"]) {
    const rows = receipt.samples.filter((r) => r.mode === mode),
      summary = {};
    for (const chosen of ["baseline", "candidate"]) {
      const selected = rows.filter((r) => r.variant === chosen);
      summary[chosen] = {
        p50: quantile(
          selected.map((r) => r.ms),
          0.5,
        ),
        p95: quantile(
          selected.map((r) => r.ms),
          0.95,
        ),
        statementCounts: [...new Set(selected.map((r) => r.count))],
      };
    }
    const paired = Array.from(
      { length: count },
      (_, i) =>
        rows.find((r) => r.i === i && r.variant === "baseline").ms -
        rows.find((r) => r.i === i && r.variant === "candidate").ms,
    );
    summary.pairedDelta = {
      p05: quantile(paired, 0.05),
      p50: quantile(paired, 0.5),
      p95: quantile(paired, 0.95),
    };
    summary.blocks = Array.from({ length: Math.ceil(count / 20) }, (_, block) => {
      const result = { block };
      for (const chosen of ["baseline", "candidate"]) {
        const selected = rows.filter(
          (r) => r.variant === chosen && r.i >= block * 20 && r.i < (block + 1) * 20,
        );
        result[chosen] = {
          p50: quantile(
            selected.map((r) => r.ms),
            0.5,
          ),
          p95: quantile(
            selected.map((r) => r.ms),
            0.95,
          ),
        };
      }
      return result;
    });
    receipt.summaries[mode] = summary;
  }
  receipt.resultHashesIdentical = true;
  receipt.completedAt = new Date().toISOString();
  receipt.loadAfter = os.loadavg();
  save("receipt", receipt);
  console.log(JSON.stringify(receipt.summaries, null, 2));
} catch (error) {
  receipt.error = String(error);
  save("receipt", receipt);
  throw error;
} finally {
  try {
    db?.close();
  } finally {
    try {
      anchor?.close();
    } finally {
      await client?.end();
    }
  }
}
