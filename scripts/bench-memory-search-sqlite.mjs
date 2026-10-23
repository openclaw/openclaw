#!/usr/bin/env node
// Production sqlite-vec KNN control for the same deterministic PostgreSQL corpus and queries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  createMemorySearchFixture,
  embedding,
  hash,
  identity,
} from "./lib/memory-search-fixture.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/bench-memory-search-sqlite.mjs

Set PGMEMSEARCH_OUT to a new output directory. Optional PGMEMSEARCH_REPO selects the
production checkout, PGMEMSEARCH_CHUNKS defaults to 20000, and PGMEMSEARCH_QUERIES
defaults to 100 (minimum 100). Five warmups precede production sqlite-vec KNN queries.
All vectors are deterministic; no embedding service or model is called.`);
  process.exit(0);
}
if (args.length) {
  throw new Error(`Unsupported argument: ${args.join(" ")}; use --help`);
}
if (!process.env.PGMEMSEARCH_OUT) {
  throw new Error("Set PGMEMSEARCH_OUT to a fresh output directory");
}
const ROOT = path.resolve(process.env.PGMEMSEARCH_REPO ?? process.cwd());
const OUT = path.resolve(process.env.PGMEMSEARCH_OUT);
const n = Number(process.env.PGMEMSEARCH_CHUNKS ?? 20_000);
const count = Number(process.env.PGMEMSEARCH_QUERIES ?? 100);
if (!Number.isInteger(count) || count < 100) {
  throw new Error("Require at least 100 queries");
}
if (!Number.isInteger(n) || n < 30 || n % 10 !== 0) {
  throw new Error("Require a chunk count that is a multiple of 10 and at least 30");
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(OUT);
const { sources } = createMemorySearchFixture(n);
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const { openNodeSqliteDatabase } = await load("src/infra/node-sqlite.ts");
const { runSqliteImmediateTransactionSync } = await load("src/infra/sqlite-transaction.ts");
const { installDatabaseProcessRole } = await load("src/infra/database-engine/admission-scope.ts");
const { loadSqliteVecExtension } = await load("src/infra/database-engine/sqlite-vec.ts");
const { MemorySourceIndexKernel } = await load(
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts",
);
const { bindSqliteWorkerBackend } = await load(
  "extensions/memory-core/src/memory/manager-publication.worker.ts",
);
const { registerOpenClawAgentDatabaseIdentity } = await load(
  "src/state/openclaw-agent-db-identity.ts",
);
const { admitMemoryVectorIndex, searchMemoryVectorIndex } = await load(
  "extensions/memory-core/src/memory/manager-search-knn.ts",
);
installDatabaseProcessRole("cli-oneshot");
const filename = path.join(OUT, "control.sqlite");
const db = openNodeSqliteDatabase(filename, { allowExtension: true });
let backend;
try {
  registerOpenClawAgentDatabaseIdentity(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
  const loaded = await loadSqliteVecExtension({ db });
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    { databasePath: filename, database: db, admit() {} },
  );
  const execute = (type, input) => {
    const result = backend.execute({ type, input });
    if (result?.ok === false) {
      throw new Error(JSON.stringify(result));
    }
    return result;
  };
  execute("schema.admit", {
    cacheEnabled: false,
    ftsEnabled: true,
    ftsTokenizer: "unicode61",
    fresh: true,
  });
  const state = {
    vector: { enabled: true, available: true },
    fts: { enabled: true, available: true },
    hasVectorTable: true,
    extensionPath: loaded.extensionPath,
  };
  execute("vector.ensure", { dimensions: 1536, currentDimensions: 1536, state });
  console.log("sqlite seed", n);
  for (let index = 0; index < sources.length; index += 10) {
    runSqliteImmediateTransactionSync(db, () =>
      new MemorySourceIndexKernel(db, state).replaceGroup(
        sources.slice(index, index + 10).map((source) => ({
          header: source,
          rows: source.chunks.map((chunk, row) => ({ chunk, embedding: source.embeddings[row] })),
        })),
      ),
    );
  }
  const index = admitMemoryVectorIndex(db);
  const times = [];
  const hashes = [];
  const loadBefore = os.loadavg();
  for (let query = -5; query < count; query++) {
    const queryIndex = Math.max(0, query);
    const started = performance.now();
    const result = await searchMemoryVectorIndex(
      index.capability,
      index.index,
      {
        providerModels: [identity.model],
        queryVec: embedding((queryIndex % 20) * 997),
        limit: 10,
        snippetMaxChars: 700,
        sourceFilter: { sql: " AND source IN (?, ?)", params: ["memory", "sessions"] },
      },
      { extensionPath: loaded.extensionPath },
    );
    if (result.fallbackScanRequired || result.rows.length !== 10) {
      throw new Error("KNN underfill");
    }
    if (query >= 0) {
      times.push(performance.now() - started);
      hashes.push(hash(JSON.stringify(result)));
    }
    if (query >= 0 && (query + 1) % 20 === 0) {
      console.log("sqlite samples", query + 1);
    }
  }
  const percentile = (p) => times.toSorted((a, b) => a - b)[Math.ceil(times.length * p) - 1];
  const report = {
    n,
    dimensions: 1536,
    queries: count,
    warmup: 5,
    node: process.version,
    fixtureHash: hash(sources.map((source) => hash(JSON.stringify(source))).join("\n")),
    boundary: "production searchMemoryVectorIndex through file-backed sqlite-vec subprocess",
    p50: percentile(0.5),
    p95: percentile(0.95),
    times,
    hashes,
    loadBefore,
    loadAfter: os.loadavg(),
    sqliteVersion: db.prepare("select sqlite_version() version, vec_version() vector").get(),
  };
  fs.writeFileSync(path.join(OUT, "sqlite-control.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ n, p50: report.p50, p95: report.p95 }));
} finally {
  try {
    backend?.close();
  } finally {
    db.close();
  }
}
