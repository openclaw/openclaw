#!/usr/bin/env node
// Real memory publication/reindex owners; no provider calls or live Gateway state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMemorySearchFixture,
  embedding,
  hash,
  identity,
  vocabulary,
} from "../lib/memory-search-fixture.mjs";
import { structuredEmbedding, structuredFixture } from "../lib/postgres-ann-fixture.mjs";

if (process.argv.length > 2) {
  if (process.argv.length !== 3 || !["--help", "-h"].includes(process.argv[2])) {
    throw new Error("Use --help for benchmark arguments");
  }
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/perf/bench-postgres-ann-publication.mjs

PGANN_WRITE_CONNECTION  Task-owned PostgreSQL URL (required).
PGANN_WRITE_OUT         Fresh output directory (required).
PGANN_WRITE_CHUNKS      Positive multiple of 10 (default 20000).
PGANN_WRITE_PAIRS       Interleaved baseline/candidate pairs (default 3).
PGANN_WRITE_CORPUS      structured (default) or random.
PGANN_WRITE_SKETCH      Generated sketch column name (default embedding_bits).
PGANN_WRITE_SEARCH      Set 1 for balanced240-draw owner retrieval plus hybrid proof.

Each arm uses a fresh schema and real cache/source publication, bounded transfer,
and atomic full reindex owners. Baseline declares vector search version 1;
candidate declares version 2. Data and output directories are retained for inspection.
No provider calls. No settings, transactions, or advisory locks are bypassed.
Canonical/native hashes must match before and after reindex and across all arms.`);
  process.exit(0);
}

const ROOT = process.cwd();
const OUT = process.env.PGANN_WRITE_OUT && path.resolve(process.env.PGANN_WRITE_OUT);
const connection = process.env.PGANN_WRITE_CONNECTION;
const n = Number(process.env.PGANN_WRITE_CHUNKS ?? 20_000);
const pairs = Number(process.env.PGANN_WRITE_PAIRS ?? 3);
const corpus = process.env.PGANN_WRITE_CORPUS ?? "structured";
const sketch = process.env.PGANN_WRITE_SKETCH ?? "embedding_bits";
const proveSearch = process.env.PGANN_WRITE_SEARCH === "1";
if (!OUT || !connection) {
  throw new Error("Set PGANN_WRITE_OUT and PGANN_WRITE_CONNECTION");
}
if (!Number.isSafeInteger(n) || n <= 0 || n % 10) {
  throw new Error("Invalid chunk count");
}
if (!Number.isSafeInteger(pairs) || pairs < 1) {
  throw new Error("Invalid pair count");
}
if (!["structured", "random"].includes(corpus)) {
  throw new Error("Invalid corpus");
}
if (!/^[a-z][a-z0-9_]*$/.test(sketch)) {
  throw new Error("Invalid sketch column name");
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(OUT);
const loadedSources = {};
const load = (file) => {
  loadedSources[file] = hash(fs.readFileSync(path.join(ROOT, file)));
  return import(pathToFileURL(path.join(ROOT, file)).href);
};
const require = createRequire(path.join(ROOT, "package.json"));
const { default: pg } = await import(require.resolve("pg"));
const { openEngineStore } = await load("src/infra/database-engine/open.ts");
const { installDatabaseProcessRole } = await load("src/infra/database-engine/admission-scope.ts");
const { openNodeSqliteDatabase } = await load("src/infra/node-sqlite.ts");
const { admitStoreSearch } = await load("src/infra/database-engine/adapters.ts");
const { preparePostgresQuery } = await load("src/infra/postgres-sync/protocol.ts");
const { memoryTextSearchSchema, memoryVectorSearchSchema } = await load(
  "extensions/memory-core/src/memory/manager-search-schema.ts",
);
const { MemorySourceIndexKernel, memoryChunkRowId } = await load(
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts",
);
const { loadMemoryEmbeddingCache, upsertMemoryEmbeddingCache } = await load(
  "extensions/memory-core/src/memory/manager-embedding-cache.ts",
);
const { bindPostgresMemoryPublication } = await load(
  "extensions/memory-core/src/memory/manager-publication-postgres.ts",
);
const {
  memoryPublicationBatches,
  memoryPublicationHeader,
  memoryPublicationInline,
  releaseMemoryPublication,
} = await load("extensions/memory-core/src/memory/manager-publication-transfer.ts");
const { markMemoryVectorIndexClean } = await load(
  "extensions/memory-core/src/memory/manager-vector-rebuild-state.ts",
);
const { searchPostgresMemoryVector, searchPostgresMemoryKeyword } = await load(
  "extensions/memory-core/src/memory/manager-search-postgres.ts",
);
const { mergeHybridResults } = await load("extensions/memory-core/src/memory/hybrid.ts");
installDatabaseProcessRole("cli-oneshot");

const fixtureStart = performance.now();
const { sources } = createMemorySearchFixture(
  n,
  corpus === "structured" ? structuredEmbedding : embedding,
);
const modelAlias = `${identity.model}-alias`;
sources.forEach((source, index) => {
  if (index % 11 === 0) {
    source.model = modelAlias;
  }
});
const canonicalRows = [];
for (const source of sources) {
  source.chunks.forEach((chunk, index) => {
    const bytes = Buffer.alloc(source.embeddings[index].length * 8);
    source.embeddings[index].forEach((value, coordinate) =>
      bytes.writeDoubleLE(value, coordinate * 8),
    );
    canonicalRows.push([
      memoryChunkRowId(source.source, source.entry.path, chunk, source.model),
      createHash("md5").update(bytes).digest("hex"),
    ]);
  });
}
canonicalRows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
const expectedCanonical = createHash("md5")
  .update(canonicalRows.map(([id, bytes]) => `${id}:${bytes}`).join(","))
  .digest("hex");
const ddl = fs.readFileSync(
  path.join(ROOT, "src/state/postgres-schema.generated/agent.postgres.sql"),
  "utf8",
);
const memoryDDL = [
  ...ddl.matchAll(/CREATE TABLE "memory_[\s\S]*?\n\);/g),
  ...ddl.matchAll(/CREATE (?:UNIQUE )?INDEX [^\n]+ ON "memory_[^\n]+;/g),
  ...ddl.matchAll(/ALTER TABLE "memory_[^\n]+;/g),
]
  .map((match) => match[0])
  .join("\n");
if (!memoryDDL.includes('CREATE TABLE "memory_index_chunks"')) {
  throw new Error("Memory schema extraction failed");
}
const save = () =>
  fs.writeFileSync(path.join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2));
const receipt = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  n,
  pairs,
  corpus,
  sketch,
  proveSearch,
  node: process.version,
  startedAt: new Date().toISOString(),
  fixtureMs: performance.now() - fixtureStart,
  fixtureHash: hash(sources.map((source) => hash(JSON.stringify(source))).join("\n")),
  expectedCanonical,
  models: { primary: identity.model, alias: modelAlias, aliasEverySources: 11 },
  structuredFixture: corpus === "structured" ? structuredFixture : undefined,
  scriptHash: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  schemaHash: hash(memoryDDL),
  sourceHashes: {
    ...loadedSources,
    "scripts/lib/memory-search-fixture.mjs": hash(
      fs.readFileSync(path.join(ROOT, "scripts/lib/memory-search-fixture.mjs")),
    ),
    "scripts/lib/postgres-ann-fixture.mjs": hash(
      fs.readFileSync(path.join(ROOT, "scripts/lib/postgres-ann-fixture.mjs")),
    ),
    "src/infra/database-engine/postgres-vector.ts": hash(
      fs.readFileSync(path.join(ROOT, "src/infra/database-engine/postgres-vector.ts")),
    ),
    "src/infra/database-engine/postgres-search-schema.ts": hash(
      fs.readFileSync(path.join(ROOT, "src/infra/database-engine/postgres-search-schema.ts")),
    ),
  },
  arms: [],
  boundary:
    "Prepared PGMEMSTORE chunks through cache/source owners and bounded full-reindex publication; excludes discovery, parsing, providers and Gateway scheduling. Baseline changes only sketch-column maintenance.",
};
save();
const state = {
  vector: { enabled: true, available: true },
  fts: { enabled: true, available: true },
  hasVectorTable: true,
};
function openDatabase(anchor, mode, existingOnly = false) {
  return openEngineStore({
    anchor,
    input: { connection, schemaPrefix: "pgann_write" },
    schema: {
      id: "memory",
      version: 1,
      postgres: memoryDDL,
      sqlite: "",
      postgresVectorDecoderVersion: 2,
      postgresVectorSearchVersion: mode === "candidate" ? 2 : 1,
    },
    existingOnly,
    openSqlite() {
      throw new Error("PostgreSQL required");
    },
    prepareAnchor() {},
    inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: existingOnly }),
  });
}
function traceDatabase(db) {
  let captured;
  const record = (sql, parameters) => captured?.push({ sql, parameters: [...parameters] });
  const query = db.query.bind(db),
    prepare = db.prepare.bind(db);
  db.query = (sql, parameters = [], ...rest) => {
    record(sql, parameters);
    return query(sql, parameters, ...rest);
  };
  db.prepare = (sql) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (["get", "all", "run", "iterate"].includes(String(key))) {
          return (...parameters) => {
            record(sql, parameters);
            return value.apply(target, parameters);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return async (run) => {
    captured = [];
    try {
      return { value: await run(), statements: captured };
    } finally {
      captured = undefined;
    }
  };
}
let active;
const statementObserver = (event) => {
  if (!active || event.engine !== "postgres") {
    return;
  }
  active.calls++;
  active.statements += event.sql.split(";").filter((part) => part.trim()).length;
  active.bridgeMs += event.durationMs;
  if (event.outcome !== "ok") {
    active.errors++;
  }
};
channel("openclaw.database.statement").subscribe(statementObserver);
async function measure(arm, name, run) {
  const sample = {
    name,
    calls: 0,
    statements: 0,
    bridgeMs: 0,
    errors: 0,
    loadBefore: os.loadavg(),
  };
  const cpu = process.cpuUsage(),
    start = performance.now();
  active = sample;
  try {
    await run();
  } finally {
    active = undefined;
    Object.assign(sample, {
      ms: performance.now() - start,
      cpu: process.cpuUsage(cpu),
      maxRss: process.resourceUsage().maxRSS,
      loadAfter: os.loadavg(),
    });
    arm.phases.push(sample);
    save();
    console.log(JSON.stringify({ pair: arm.pair, mode: arm.mode, ...sample }));
  }
}

async function runArm(pair, mode) {
  const armDir = path.join(OUT, `pair-${pair}-${mode}`);
  fs.mkdirSync(armDir);
  const arm = { pair, mode, phases: [] };
  receipt.arms.push(arm);
  let db, anchor, client, backend;
  try {
    anchor = openNodeSqliteDatabase(path.join(armDir, "anchor.sqlite"));
    db = openDatabase(anchor, mode);
    arm.namespace = String(db.prepare("SELECT current_schema() AS name").get().name);
    save();
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query(`SET search_path TO "${arm.namespace}", public`);
    db.runTransaction(() => {
      admitStoreSearch(db, memoryTextSearchSchema("unicode61"), { extension: "memory.text" });
      admitStoreSearch(db, memoryVectorSearchSchema(1536), { extension: "memory.vector" });
      db.exec("INSERT INTO memory_index_state(id,revision) VALUES (1,0)");
    });
    // Both layouts are admitted by the schema owner, never changed behind its catalog seal.
    const columns = (
      await client.query(
        "SELECT attname FROM pg_attribute WHERE attrelid='memory_index_chunks_vec'::regclass AND attgenerated='s' AND NOT attisdropped",
      )
    ).rows;
    if (columns.some((column) => column.attname !== sketch)) {
      throw new Error("Unexpected derived column");
    }
    if (columns.length !== Number(mode === "candidate")) {
      throw new Error("Schema owner did not admit the requested vector search version");
    }
    arm.schema = (
      await client.query(
        "SELECT attname,format_type(atttypid,atttypmod) AS type,attgenerated FROM pg_attribute WHERE attrelid='memory_index_chunks_vec'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",
      )
    ).rows;
    async function storage() {
      const canonical = (
        await client.query(
          "SELECT count(*)::int AS rows,md5(string_agg(id||':'||md5(embedding),',' ORDER BY id COLLATE \"C\")) AS hash FROM memory_index_chunks",
        )
      ).rows[0];
      const vector = (
        await client.query(
          "SELECT count(*)::int AS rows,md5(string_agg(id||':'||md5(vector_send(embedding)),',' ORDER BY id COLLATE \"C\")) AS hash FROM memory_index_chunks_vec",
        )
      ).rows[0];
      if (canonical.rows !== n || vector.rows !== n || canonical.hash !== expectedCanonical) {
        throw new Error("Canonical bytes/count changed");
      }
      const bytes = (
        await client.query(
          "SELECT pg_total_relation_size('memory_index_chunks_vec')::text AS vector_bytes,pg_total_relation_size('memory_index_chunks')::text AS canonical_bytes",
        )
      ).rows[0];
      return { canonical, vector, ...bytes };
    }
    await measure(arm, "initial", () => {
      for (let offset = 0; offset < sources.length; offset += 10) {
        const group = sources.slice(offset, offset + 10);
        db.runTransaction(() => {
          upsertMemoryEmbeddingCache({
            db,
            cacheSize: { size: offset * 10, exact: true },
            provider: { id: identity.provider, model: identity.model },
            providerKey: identity.providerKey,
            entries: () =>
              group.flatMap((source) =>
                source.chunks.map((chunk, index) => ({
                  hash: chunk.hash,
                  embedding: source.embeddings[index],
                })),
              ),
            maxEntries: n + 100,
            now: 1_760_000_000_000,
          });
          new MemorySourceIndexKernel(db, state).replaceGroup(
            group.map((source) => ({
              header: source,
              rows: source.chunks.map((chunk, index) => ({
                chunk,
                embedding: source.embeddings[index],
              })),
            })),
          );
        });
        if (offset % 200 === 0) {
          console.log(`initial ${mode} ${offset * 10}/${n}`);
        }
      }
      db.runTransaction(() => markMemoryVectorIndexClean(db));
    });
    arm.initialStorage = await storage();
    await client.query(
      "VACUUM (ANALYZE) memory_index_chunks_vec, memory_index_chunks, memory_index_sources, memory_embedding_cache",
    );
    backend = bindPostgresMemoryPublication({
      database: db,
      admit() {},
      admitSearchExtensions(definitions) {
        for (const [extension, definition] of Object.entries(definitions)) {
          db.runTransaction(() => admitStoreSearch(db, definition, { extension }));
        }
      },
    });
    const execute = (type, input) => {
      const result = backend.execute({ type, input });
      if (result?.ok === false) {
        throw new Error(JSON.stringify(result));
      }
      return result;
    };
    await measure(arm, "fullReindex", () => {
      execute("database.stage.start");
      const facts = execute("index.facts");
      for (let offset = 0; offset < sources.length; offset += 10) {
        const group = sources.slice(offset, offset + 10);
        const cache = loadMemoryEmbeddingCache({
          db,
          providerIdentities: [identity],
          hashes: group.flatMap((source) => source.chunks.map((chunk) => chunk.hash)),
        });
        if (cache.size !== group.length * 10) {
          throw new Error("Unexpected cache miss");
        }
        for (const source of group) {
          const replacement = {
            ...source,
            embeddings: source.chunks.map((chunk) => cache.get(chunk.hash)),
          };
          try {
            const inline = memoryPublicationInline(replacement);
            if (inline) {
              execute("source.replace.inline", { ...inline, state });
            } else {
              execute("stage.start", { header: memoryPublicationHeader(replacement) });
              for (const fragments of memoryPublicationBatches(replacement)) {
                execute("stage.append", { fragments });
              }
              execute("source.replace", { state });
            }
          } finally {
            releaseMemoryPublication(replacement);
          }
        }
        if (offset % 200 === 0) {
          console.log(`staging ${mode} ${offset * 10}/${n}`);
        }
      }
      execute("index.writeMetadata", {
        model: identity.model,
        provider: identity.provider,
        providerKey: identity.providerKey,
        sources: ["memory", "sessions"],
        chunkTokens: 400,
        chunkOverlap: 80,
        vectorDims: 1536,
      });
      const start = performance.now();
      execute("database.stage.publish", {
        expectedRevision: facts.revision,
        vectorIndexComplete: true,
      });
      arm.finalPublicationMs = performance.now() - start;
      backend.close();
      backend = undefined;
    });
    arm.finalStorage = await storage();
    if (JSON.stringify(arm.initialStorage.vector) !== JSON.stringify(arm.finalStorage.vector)) {
      throw new Error("Reindex changed native projection");
    }
    if (mode === "candidate" && proveSearch) {
      arm.hybrid = [];
      const trace = traceDatabase(db);
      const sourceFilter = { sql: " AND source IN (?, ?)", params: ["memory", "sessions"] };
      for (let index = 0; index < 20; index++) {
        const query = `${vocabulary[index % vocabulary.length]} topic${index}`;
        const vectorResult = await trace(() =>
          searchPostgresMemoryVector(db, {
            providerModel: identity.model,
            providerModelAliases: [modelAlias],
            queryVec:
              corpus === "structured"
                ? structuredEmbedding(index, "query")
                : sources[index % sources.length].embeddings[0],
            limit: 10,
            snippetMaxChars: 700,
            sourceFilter,
          }),
        );
        const vector = vectorResult.value;
        const keywordResult = await trace(() =>
          searchPostgresMemoryKeyword(db, {
            body: {
              query,
              limit: 20,
              snippetMaxChars: 700,
              ftsTokenizer: "unicode61",
              sourceFilter,
              ftsTable: "memory_index_chunks_fts",
            },
            path: {
              query,
              limit: 20,
              snippetMaxChars: 700,
              ftsTokenizer: "unicode61",
              sourceFilter,
              pathFtsTable: "memory_index_paths_fts",
            },
          }),
        );
        const keyword = keywordResult.value;
        if (
          vector.length !== 10 ||
          keyword.body.error ||
          keyword.path.error ||
          !keyword.body.rows.length
        ) {
          throw new Error("Production retrieval failed");
        }
        const hybrid = await mergeHybridResults({
          vector: vector.map((row) => ({ ...row, vectorScore: row.score })),
          keyword: [...keyword.body.rows, ...keyword.path.rows],
          vectorWeight: 0.7,
          textWeight: 0.3,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        });
        if (!hybrid.length || hybrid.some((row) => !Number.isFinite(row.score) || !row.snippet)) {
          throw new Error("Production hybrid failed");
        }
        arm.hybrid.push({
          query,
          vector: hash(JSON.stringify(vector)),
          keyword: hash(JSON.stringify(keyword)),
          hybrid: hash(JSON.stringify(hybrid)),
          results: hybrid.length,
          statements: {
            vector: vectorResult.statements.length,
            keyword: keywordResult.statements.length,
            hybrid: vectorResult.statements.length + keywordResult.statements.length,
          },
        });
      }
    }
    save();
  } finally {
    backend?.close();
    db?.close();
    anchor?.close();
    await client?.end();
  }
}

async function proveRetrieval() {
  const handles = [];
  const representatives = [];
  const result = {
    distinctDraws: 240,
    candidateDraws: 20,
    warmupsPerScope: 5,
    samples: [],
    summaries: [],
  };
  receipt.retrieval = result;
  const draw = (index) =>
    corpus === "structured"
      ? structuredEmbedding(index, "query")
      : embedding(1_000_000 + n + index * 101);
  const candidateIds = sources
    .flatMap((source) =>
      source.model === identity.model
        ? source.chunks.map((chunk) =>
            memoryChunkRowId(source.source, source.entry.path, chunk, source.model),
          )
        : [],
    )
    .slice(0, 40);
  const excludedSessionPaths = sources
    .filter((source) => source.source === "sessions")
    .slice(0, 2)
    .map((source) => source.entry.path);
  const scopes = [
    {
      name: "all",
      models: [identity.model, modelAlias],
      sourceFilter: { sql: "", params: [] },
      count: 60,
    },
    { name: "model", models: [identity.model], sourceFilter: { sql: "", params: [] }, count: 60 },
    {
      name: "memory",
      models: [identity.model],
      sourceFilter: { sql: " AND source = ?", params: ["memory"] },
      count: 60,
    },
    {
      name: "excluded-sessions",
      models: [identity.model],
      sourceFilter: { sql: " AND source = ?", params: ["sessions"], excludedSessionPaths },
      count: 60,
    },
    {
      name: "candidate-40",
      models: [identity.model],
      sourceFilter: { sql: "", params: [] },
      candidateIds,
      count: 20,
    },
  ];
  const percentile = (values, quantile) =>
    values.toSorted((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
  try {
    for (const mode of ["baseline", "candidate"]) {
      const anchor = openNodeSqliteDatabase(path.join(OUT, `pair-0-${mode}`, "anchor.sqlite"));
      const db = openDatabase(anchor, mode, true);
      handles.push({ mode, anchor, db, trace: traceDatabase(db) });
    }
    const [baseline, candidate] = handles;
    for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
      const scope = scopes[scopeIndex];
      let selected = sources.filter((source) => scope.models.includes(source.model));
      if (scope.sourceFilter.params.length) {
        selected = selected.filter((source) => scope.sourceFilter.params.includes(source.source));
      }
      if (scope.sourceFilter.excludedSessionPaths) {
        selected = selected.filter(
          (source) => !scope.sourceFilter.excludedSessionPaths.includes(source.entry.path),
        );
      }
      const eligible = scope.candidateIds
        ? scope.candidateIds.length
        : selected.reduce((sum, source) => sum + source.chunks.length, 0);
      const allowedIds = new Set(
        scope.candidateIds ??
          selected.flatMap((source) =>
            source.chunks.map((chunk) =>
              memoryChunkRowId(source.source, source.entry.path, chunk, source.model),
            ),
          ),
      );
      for (let index = -5; index < scope.count; index++) {
        const drawIndex = index < 0 ? 50_000 + scopeIndex * 5 + index + 5 : scopeIndex * 60 + index;
        const query = {
          providerModel: scope.models[0],
          providerModelAliases: scope.models.slice(1),
          sourceFilter: scope.sourceFilter,
          candidateIds: scope.candidateIds,
          queryVec: draw(drawIndex),
          limit: 10,
          snippetMaxChars: 700,
        };
        const measured = {};
        for (const handle of index % 2 ? [candidate, baseline] : [baseline, candidate]) {
          const start = performance.now();
          try {
            const traced = await handle.trace(() => searchPostgresMemoryVector(handle.db, query));
            measured[handle.mode] = {
              ms: performance.now() - start,
              rows: traced.value,
              statements: traced.statements.length,
            };
            if (index === 0 && ["all", "candidate-40"].includes(scope.name)) {
              representatives.push({
                mode: handle.mode,
                scope: scope.name,
                statements: traced.statements,
              });
            }
          } catch (error) {
            measured[handle.mode] = {
              ms: performance.now() - start,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (index < 0) {
          if (measured.baseline.error || measured.candidate.error) {
            throw new Error("Owner retrieval warmup failed");
          }
          continue;
        }
        const exact = measured.baseline.rows ?? [],
          approximate = measured.candidate.rows ?? [];
        const expectedRows = Math.min(10, eligible);
        const exactIds = new Set(exact.map((row) => row.id));
        const recall = exact.length
          ? approximate.filter((row) => exactIds.has(row.id)).length / exact.length
          : approximate.length
            ? 0
            : 1;
        result.samples.push({
          scope: scope.name,
          drawIndex,
          eligible,
          expectedRows,
          recall,
          exact: {
            ms: measured.baseline.ms,
            error: measured.baseline.error,
            ids: exact.map((row) => row.id),
            scores: exact.map((row) => row.score),
            statements: measured.baseline.statements,
          },
          candidate: {
            ms: measured.candidate.ms,
            error: measured.candidate.error,
            ids: approximate.map((row) => row.id),
            scores: approximate.map((row) => row.score),
            statements: measured.candidate.statements,
          },
          exactUnderfilled: exact.length < expectedRows,
          candidateUnderfilled: approximate.length < expectedRows,
          scopeLeaks: [...exact, ...approximate].filter((row) => !allowedIds.has(row.id)).length,
        });
        if (index % 20 === 0) {
          save();
          console.log(`retrieval ${scope.name} ${index}/${scope.count}`);
        }
      }
      const rows = result.samples.filter((sample) => sample.scope === scope.name);
      const exactTimes = rows.map((sample) => sample.exact.ms),
        candidateTimes = rows.map((sample) => sample.candidate.ms);
      result.summaries.push({
        scope: scope.name,
        samples: rows.length,
        eligible,
        recall: rows.reduce((sum, sample) => sum + sample.recall, 0) / rows.length,
        exactP50: percentile(exactTimes, 0.5),
        exactP95: percentile(exactTimes, 0.95),
        candidateP50: percentile(candidateTimes, 0.5),
        candidateP95: percentile(candidateTimes, 0.95),
        speedup: percentile(exactTimes, 0.5) / percentile(candidateTimes, 0.5),
        failed: rows.filter((sample) => sample.exact.error || sample.candidate.error).length,
        exactUnderfilled: rows.filter((sample) => sample.exactUnderfilled).length,
        candidateUnderfilled: rows.filter((sample) => sample.candidateUnderfilled).length,
        inherentlyShort: rows.filter((sample) => sample.eligible < 10).length,
        scopeLeaks: rows.reduce((sum, sample) => sum + sample.scopeLeaks, 0),
      });
      save();
    }
    if (
      result.summaries.some(
        (summary) =>
          summary.failed ||
          summary.exactUnderfilled ||
          summary.candidateUnderfilled ||
          summary.scopeLeaks,
      )
    ) {
      throw new Error("Owner retrieval failed or lost eligible results");
    }
    const client = new pg.Client({ connectionString: connection });
    try {
      await client.connect();
      result.plans = [];
      for (const representative of representatives) {
        const arm = receipt.arms.find(
          (value) => value.pair === 0 && value.mode === representative.mode,
        );
        await client.query(`SET search_path TO "${arm.namespace}", public`);
        for (const statement of representative.statements) {
          const native = preparePostgresQuery(statement.sql).sql;
          const plan = (
            await client.query(
              "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + native,
              statement.parameters,
            )
          ).rows;
          result.plans.push({
            mode: representative.mode,
            scope: representative.scope,
            sql: native,
            parameters: statement.parameters,
            plan,
          });
        }
      }
    } finally {
      await client.end();
    }
  } finally {
    for (const handle of handles) {
      handle.db.close();
      handle.anchor.close();
    }
    save();
  }
}

try {
  for (let pair = 0; pair < pairs; pair++) {
    for (const mode of pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      await runArm(pair, mode);
    }
  }
  const vectorHashes = new Set(receipt.arms.map((arm) => arm.finalStorage.vector.hash));
  if (vectorHashes.size !== 1) {
    throw new Error("Different native vectors across arms");
  }
  if (proveSearch) {
    for (const source of sources) {
      source.embeddings = [];
    }
    canonicalRows.length = 0;
    receipt.retrievalMemory = {
      embeddingsReleased: true,
      explicitGc: false,
      usage: process.memoryUsage(),
    };
    await proveRetrieval();
  }
  receipt.complete = true;
  save();
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : String(error);
  save();
  throw error;
} finally {
  channel("openclaw.database.statement").unsubscribe(statementObserver);
}
