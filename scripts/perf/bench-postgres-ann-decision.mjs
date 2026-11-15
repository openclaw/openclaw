#!/usr/bin/env node
// Native SQL decision workload; production publication and Gateway proof remain separate.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { embedding, hash } from "../lib/memory-search-fixture.mjs";
import { structuredEmbedding, structuredFixture } from "../lib/postgres-ann-fixture.mjs";

if (process.argv.includes("--help")) {
  console.log(`PGANN_CONNECTION=<isolated PG URL> PGANN_OUT=<new directory>
  PGANN_CHUNKS=20000 PGANN_QUERIES=200 PGANN_CORPUS=structured|random
  PGANN_METHODS=binary4,binary8,binary16 (or hnsw40,hnsw100,hnsw200)
  PGANN_GRAPH=default|strong PGANN_SCHEMA=<existing task schema>
  PGANN_FILTERS=all,model,memory,excluded-sessions,candidate-40
  PGANN_DISTINCT_SCOPES=1 (disjoint query draws per canonical scope)
  PGANN_SEED_ONLY=1 (prepare corpus and measure backfill without queries)
  PGANN_REUSE_INDEX=1 (reuse a verified matching HNSW graph for full query proof)
  node scripts/perf/bench-postgres-ann-decision.mjs

New schema: seed unchanged corpus, measure generated nullable-bit column backfill.
HNSW methods: build the selected graph (m16/ef64 or m32/ef128), with90s timeout.
The script retains task data for subsequent phases. Never target a production DB.
Queries are independent corpus-distribution draws, with five warmups and AB/BA
exact/candidate comparisons. Binary prefilters retain only IDs before reranking.
Raw samples, EXPLAIN plans, graph/backfill cost and hashes are saved.`);
  process.exit(0);
}
const n = Number(process.env.PGANN_CHUNKS ?? 20000);
const count = Number(process.env.PGANN_QUERIES ?? 200);
const corpus = process.env.PGANN_CORPUS ?? "structured";
const methods = (process.env.PGANN_METHODS ?? "binary4,binary8,binary16").split(",");
const graph = process.env.PGANN_GRAPH ?? "default";
const out = process.env.PGANN_OUT;
if (
  !out ||
  !process.env.PGANN_CONNECTION ||
  !Number.isInteger(n) ||
  n < 100 ||
  n % 10 ||
  !Number.isInteger(count) ||
  count < 20 ||
  !["structured", "random"].includes(corpus) ||
  !["default", "strong"].includes(graph) ||
  methods.some((method) => !/^(binary(4|8|16)|hnsw(40|100|200))$/.test(method)) ||
  (methods.some((m) => m.startsWith("binary")) && methods.some((m) => m.startsWith("hnsw")))
) {
  throw new Error("Invalid benchmark settings; see --help");
}
fs.mkdirSync(out);
const schema = process.env.PGANN_SCHEMA ?? `pgann2_${process.pid}_${Date.now()}`;
if (!/^pgann2_\d+_\d+$/.test(schema)) {
  throw new Error("Require a task-owned schema");
}
const vector = (values) => `[${values.map(Math.fround).join(",")}]`;
const draw = (i, stream) =>
  corpus === "structured"
    ? structuredEmbedding(i, stream)
    : embedding(stream === "query" ? 1_000_000 + n + i * 101 : i);
const model = `pgann-${corpus}-1536`;
const filters = [
  { name: "all", sql: "c.model <> 'eligibility-witness'", values: [] },
  { name: "model", sql: "c.model = $2", values: [model] },
  { name: "memory", sql: "c.model = $2 AND c.source = 'memory'", values: [model] },
  {
    name: "excluded-sessions",
    sql: "c.model = $2 AND c.source = 'sessions' AND c.path <> ALL($3::text[])",
    values: [model, ["sessions/000001.jsonl", "sessions/000002.jsonl"]],
  },
  {
    name: "candidate-40",
    sql: "c.model = $2 AND c.id = ANY($3::text[])",
    values: [model, Array.from({ length: 40 }, (_, i) => String(i))],
  },
].filter(
  (f) => !process.env.PGANN_FILTERS || process.env.PGANN_FILTERS.split(",").includes(f.name),
);
const client = new pg.Client({ connectionString: process.env.PGANN_CONNECTION });
await client.connect();
const receipt = {
  startedAt: new Date().toISOString(),
  schema,
  n,
  count,
  corpus,
  graph,
  methods,
  distinctScopeDraws: process.env.PGANN_DISTINCT_SCOPES === "1",
  seedOnly: process.env.PGANN_SEED_ONLY === "1",
  plannedDistinctQueries:
    process.env.PGANN_DISTINCT_SCOPES === "1" ? count * filters.length : count,
  effectiveDistinctBroadQueries: 0,
  acceptanceSampleSize: false,
  benchmarkHash: hash(fs.readFileSync(new URL(import.meta.url))),
  generatorHash: hash(fs.readFileSync(new URL("../lib/postgres-ann-fixture.mjs", import.meta.url))),
  randomGeneratorHash: hash(
    fs.readFileSync(new URL("../lib/memory-search-fixture.mjs", import.meta.url)),
  ),
  generator: structuredFixture,
  platform: { node: process.version, cpus: os.cpus().length, loadBefore: os.loadavg() },
  samples: [],
  summaries: [],
  plans: [],
  notices: [],
};
client.on("notice", (notice) => {
  const recorded = {
    severity: notice.severity,
    message: notice.message,
    detail: notice.detail,
    hint: notice.hint,
  };
  receipt.notices.push(recorded);
  console.log(JSON.stringify({ event: "postgres-notice", ...recorded }));
});
const save = () => {
  const draws = new Set();
  for (const sample of receipt.samples) {
    if (sample.filter !== "candidate-40") {
      draws.add(receipt.queries[sample.filter].firstDraw + sample.i);
    }
  }
  receipt.effectiveDistinctBroadQueries = draws.size;
  receipt.acceptanceSampleSize = draws.size >= 200;
  fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
};
save();
const sqlFor = (filter, method) => {
  if (method.startsWith("binary")) {
    const limit = 10 * Number(method.slice(6));
    return `WITH candidates AS MATERIALIZED (
      SELECT v.id FROM vectors v JOIN chunks c USING(id)
      WHERE v.sketch IS NOT NULL AND ${filter.sql}
      ORDER BY v.sketch <~> binary_quantize($1::vector)::bit(1536), v.id LIMIT ${limit}
    ) SELECT v.id, v.embedding <=> $1::vector AS distance FROM candidates k
      JOIN vectors v USING(id) ORDER BY distance, v.id LIMIT 10`;
  }
  return `SELECT v.id, v.embedding <=> $1::vector AS distance FROM vectors v JOIN chunks c USING(id)
    WHERE vector_norm(v.embedding) > 0 AND ${filter.sql}
    ORDER BY ${method === "exact" ? "(v.embedding <=> $1::vector) + 0" : "v.embedding <=> $1::vector"}, v.id LIMIT 10`;
};
async function setQueryOptions(method) {
  if (method.startsWith("hnsw")) {
    await client.query(`SET LOCAL hnsw.ef_search = ${Number(method.slice(4))}`);
    await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    await client.query("SET LOCAL hnsw.max_scan_tuples = 20000");
  }
}
async function run(filter, method, q) {
  await client.query("BEGIN READ ONLY");
  try {
    await setQueryOptions(method);
    const start = performance.now();
    const result = await client.query(sqlFor(filter, method), [q, ...filter.values]);
    const ms = performance.now() - start;
    await client.query("COMMIT");
    return { ms, ids: result.rows.map((r) => r.id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function measureDdl(label, sql) {
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  let peakRssKiB = 0;
  const monitor = setInterval(() => {
    try {
      peakRssKiB = Math.max(
        peakRssKiB,
        Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()),
      );
    } catch {
      /* SQL records a backend failure. */
    }
  }, 200);
  const start = performance.now();
  let maintenanceWorkMem;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='90s'");
    if (label === "indexBuild") {
      await client.query("SET LOCAL maintenance_work_mem='1GB'");
    }
    maintenanceWorkMem = (await client.query("SHOW maintenance_work_mem")).rows[0]
      .maintenance_work_mem;
    await client.query(sql);
    await client.query("COMMIT");
    receipt[label] = {
      ms: performance.now() - start,
      peakRssKiB,
      maintenanceWorkMem,
      complete: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    receipt[label] = {
      ms: performance.now() - start,
      peakRssKiB,
      maintenanceWorkMem,
      complete: false,
      error: String(error),
    };
    save();
    throw error;
  } finally {
    clearInterval(monitor);
  }
}
const quantile = (values, q) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1];
const stats = (values) => ({ p50: quantile(values, 0.5), p95: quantile(values, 0.95) });
try {
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  receipt.postgres = (
    await client.query(
      "SELECT version() AS version, (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector_version",
    )
  ).rows[0];
  receipt.settings = (
    await client.query(
      "SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','maintenance_work_mem','max_parallel_maintenance_workers','max_parallel_workers','work_mem') ORDER BY name",
    )
  ).rows;
  if (!process.env.PGANN_SCHEMA) {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(
      "CREATE TABLE chunks(id text PRIMARY KEY, model text NOT NULL, source text NOT NULL, path text NOT NULL)",
    );
    await client.query(
      "CREATE TABLE vectors(id text PRIMARY KEY REFERENCES chunks(id), embedding vector(1536) NOT NULL)",
    );
    await client.query("CREATE INDEX chunks_model ON chunks(model)");
    await client.query("CREATE TABLE fixture_config(config jsonb NOT NULL)");
    await client.query("INSERT INTO fixture_config VALUES ($1)", [
      JSON.stringify({ n, corpus, generatorHash: receipt.generatorHash }),
    ]);
    const start = performance.now();
    const corpusHash = [];
    await client.query("BEGIN");
    for (let offset = 0; offset < n; offset += 100) {
      const rows = Array.from({ length: Math.min(100, n - offset) }, (_, j) => {
        const id = offset + j,
          sourceIndex = Math.floor(id / 10),
          source = sourceIndex % 5 === 0 ? "memory" : "sessions";
        const values = draw(id, "corpus");
        corpusHash.push(hash(Buffer.from(new Float64Array(values).buffer)));
        return {
          id: String(id),
          model: id % 11 === 0 ? "other-model" : model,
          source,
          path:
            source === "memory"
              ? `memory/project-${sourceIndex}/notes.md`
              : `sessions/${String(sourceIndex).padStart(6, "0")}.jsonl`,
          embedding: vector(values),
        };
      });
      await client.query(
        "WITH rows AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, model text, source text, path text, embedding text)), inserted AS (INSERT INTO chunks SELECT id,model,source,path FROM rows RETURNING id) INSERT INTO vectors SELECT rows.id,rows.embedding::vector FROM rows JOIN inserted USING(id)",
        [JSON.stringify(rows)],
      );
      if (offset % 10000 === 0) {
        console.log(`seed ${offset}/${n}`);
      }
    }
    await client.query(
      "INSERT INTO chunks VALUES ('zero','eligibility-witness','memory','witness/zero'),('negative','eligibility-witness','memory','witness/negative')",
    );
    await client.query("INSERT INTO vectors VALUES ('zero',$1::vector),('negative',$2::vector)", [
      vector(Array(1536).fill(0)),
      vector(Array(1536).fill(-1 / Math.sqrt(1536))),
    ]);
    await client.query("COMMIT");
    receipt.seed = { ms: performance.now() - start, corpusHash: hash(corpusHash.join("\n")) };
    await measureDdl(
      "backfill",
      "ALTER TABLE vectors ADD COLUMN sketch bit(1536) GENERATED ALWAYS AS (CASE WHEN vector_norm(embedding)>0 THEN binary_quantize(embedding)::bit(1536) ELSE NULL END) STORED",
    );
    console.log(JSON.stringify({ seed: receipt.seed, backfill: receipt.backfill }));
  } else {
    await client.query(`SET search_path TO ${schema}, public`);
    const config = (await client.query("SELECT config FROM fixture_config")).rows[0].config;
    if (
      config.n !== n ||
      config.corpus !== corpus ||
      config.generatorHash !== receipt.generatorHash
    ) {
      throw new Error("Reused fixture identity mismatch");
    }
    receipt.reusedSchema = true;
  }
  await client.query("ANALYZE chunks");
  await client.query("ANALYZE vectors");
  receipt.eligibility = (
    await client.query(
      "SELECT id, sketch IS NULL AS null_sketch, bit_count(sketch)::int AS bits FROM vectors WHERE id IN ('zero','negative') ORDER BY id",
    )
  ).rows;
  if (
    receipt.eligibility[0]?.id !== "negative" ||
    receipt.eligibility[0].null_sketch ||
    receipt.eligibility[0].bits !== 0 ||
    !receipt.eligibility[1]?.null_sketch
  ) {
    throw new Error("Zero/negative eligibility mismatch");
  }
  if (methods[0].startsWith("hnsw")) {
    if (process.env.PGANN_REUSE_INDEX === "1") {
      const existing = (
        await client.query(
          "SELECT i.indisvalid, i.indisready, c.reloptions FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid='vectors_hnsw'::regclass",
        )
      ).rows[0];
      if (
        !existing?.indisvalid ||
        !existing.indisready ||
        !existing.reloptions?.includes(`m=${graph === "strong" ? 32 : 16}`) ||
        !existing.reloptions.includes(`ef_construction=${graph === "strong" ? 128 : 64}`)
      ) {
        throw new Error("Existing HNSW graph does not match the selected construction");
      }
      receipt.reusedIndex = existing;
    } else {
      await client.query("DROP INDEX IF EXISTS vectors_hnsw");
      await measureDdl(
        "indexBuild",
        `CREATE INDEX vectors_hnsw ON vectors USING hnsw(embedding vector_cosine_ops) WITH (m=${graph === "strong" ? 32 : 16}, ef_construction=${graph === "strong" ? 128 : 64})`,
      );
      console.log(JSON.stringify({ graph, indexBuild: receipt.indexBuild }));
    }
  }
  receipt.relations = (
    await client.query(
      "SELECT c.relname, pg_relation_size(c.oid)::float8 AS main_bytes, pg_total_relation_size(c.oid)::float8 AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname",
      [schema],
    )
  ).rows;
  receipt.queries = {};
  for (const filter of process.env.PGANN_SEED_ONLY === "1" ? [] : filters) {
    const scopeIndex = ["all", "model", "memory", "excluded-sessions", "candidate-40"].indexOf(
      filter.name,
    );
    const offset = process.env.PGANN_DISTINCT_SCOPES === "1" ? scopeIndex * count : 0;
    const queries = Array.from({ length: count }, (_, i) => vector(draw(offset + i, "query")));
    receipt.queries[filter.name] = {
      firstDraw: offset,
      lastDraw: offset + count - 1,
      hash: hash(queries.join("\n")),
    };
    for (const method of ["exact", ...methods]) {
      await client.query("BEGIN READ ONLY");
      await setQueryOptions(method);
      const plans = (
        await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sqlFor(filter, method), [
          queries[17],
          ...filter.values,
        ])
      ).rows;
      await client.query("COMMIT");
      const serialized = JSON.stringify(plans, null, 2);
      fs.writeFileSync(path.join(out, `plan-${filter.name}-${method}.json`), serialized);
      receipt.plans.push({
        filter: filter.name,
        method,
        hnswUsed: serialized.includes('"Index Name": "vectors_hnsw"'),
      });
    }
    for (let i = 0; i < 5; i++) {
      for (const method of ["exact", ...methods]) {
        await run(filter, method, queries[i]);
      }
    }
    for (let i = 0; i < count; i++) {
      const pair = {};
      for (const method of i % 2 ? methods.toReversed().concat("exact") : ["exact", ...methods]) {
        pair[method] = await run(filter, method, queries[i]);
      }
      for (const method of methods) {
        const exact = pair.exact,
          candidate = pair[method];
        receipt.samples.push({
          filter: filter.name,
          method,
          i,
          exactMs: exact.ms,
          candidateMs: candidate.ms,
          recall: candidate.ids.filter((id) => exact.ids.includes(id)).length / exact.ids.length,
          exactIds: exact.ids,
          candidateIds: candidate.ids,
          underfilled: candidate.ids.length < exact.ids.length,
        });
      }
      if (i % 20 === 19) {
        save();
        console.log(`${filter.name} ${i + 1}/${count}`);
      }
    }
    for (const method of methods) {
      const rows = receipt.samples.filter((r) => r.filter === filter.name && r.method === method);
      const exact = stats(rows.map((r) => r.exactMs)),
        candidate = stats(rows.map((r) => r.candidateMs));
      receipt.summaries.push({
        filter: filter.name,
        method,
        exact,
        candidate,
        speedup: exact.p50 / candidate.p50,
        recall: rows.reduce((sum, r) => sum + r.recall, 0) / rows.length,
        underfilled: rows.filter((r) => r.underfilled).length,
      });
    }
    console.log(JSON.stringify(receipt.summaries.filter((r) => r.filter === filter.name)));
    save();
  }
  receipt.completedAt = new Date().toISOString();
  receipt.platform.loadAfter = os.loadavg();
} catch (error) {
  receipt.error = String(error);
  throw error;
} finally {
  save();
  await client.end();
}
