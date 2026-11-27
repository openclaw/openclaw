// Synthetic admission inheritance, using the complete allocation/publication owners.
// No native database, Gateway throughput, or packaged-RSS claim. Native helpers fail closed.
// node scripts/perf/sqlite-scope-inheritance-measure.mjs SOURCE_ROOT BASELINE_RECEIPTS [PAIRS]
// Acceptance: fewer backing stores; no >20% median regression in heap, RSS, or startup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const [root, baseline, count = "5", sampleOwner] = process.argv.slice(2);
assert(root && baseline, "SOURCE_ROOT and BASELINE_RECEIPTS are required");
const pairs = Number(count);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const candidate = path.join(root, "src/infra/sqlite-database-write-receipts.ts");
if (!sampleOwner) {
  const rows = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const [label, owner] of [
      ["base", baseline],
      ["candidate", candidate],
    ]) {
      const output = execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), root, baseline, count, owner],
        { encoding: "utf8" },
      );
      rows.push({ pair, label, ...JSON.parse(output) });
    }
  }
  const distribution = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  };
  const summary = Object.fromEntries(
    ["base", "candidate"].map((label) => {
      const selected = rows.filter((row) => row.label === label);
      return [
        label,
        Object.fromEntries(
          ["backingStores", "workerHeap", "rssDelta", "startupMs"].map((metric) => [
            metric,
            distribution(selected.map((row) => row[metric])),
          ]),
        ),
      ];
    }),
  );
  console.log(JSON.stringify({ node: process.version, load: loadavg(), pairs, summary, rows }));
  process.exit(0);
}

const scratch = mkdtempSync(path.join(tmpdir(), "sqlite-scope-inheritance-"));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const stripImports = (source) => source.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
try {
  const recordSource = read("src/infra/sqlite-database-admission-record.ts");
  const receiptsSource = readFileSync(sampleOwner, "utf8");
  const identity = read("src/infra/sqlite-worker-identity.ts");
  const normalize = identity.slice(
    identity.indexOf("export function normalizeDatabasePath("),
    identity.indexOf("export function readDatabaseFileIdentity("),
  );
  assert(normalize.startsWith("export function normalizeDatabasePath("));
  const capsule = [
    'import { randomUUID } from "node:crypto";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { toUSVString } from "node:util";',
    'import { setEnvironmentData, threadId } from "node:worker_threads";',
    read("src/shared/global-singleton.ts"),
    read("src/infra/sqlite-database-admission-key.ts"),
    read("src/infra/sqlite-database-admission-delta.ts"),
    "const changedWriteScopes = changedAdmissionWriteScopes;",
    normalize,
    `function unsupported() { throw new Error("operation outside admission inheritance proof"); }
     const isSoleDatabaseFileDescriptor = unsupported;
     const readDatabaseIdentityBirthtime = unsupported;
     const normalizeWindowsPathPreservingCase = unsupported;
     const isPromiseLike = unsupported;
     const notifyListeners = unsupported;
     const registerListener = unsupported;
     const sqlPublicationAnchor = unsupported;
     const isPreparingSqliteNativeMutation = unsupported;
     const hasSqlitePostCommitScope = unsupported;
     const stageSqliteTransactionState = unsupported;`,
    stripImports(recordSource),
    "const isRetired = isSqliteDatabaseAdmissionRetired;",
    stripImports(receiptsSource),
  ].join("\n");
  const moduleFile = path.join(scratch, "owners.mjs");
  writeFileSync(moduleFile, stripTypeScriptTypes(capsule));
  const { SqliteDatabaseAdmissionRegistry, createSqliteDatabaseWriteReceipts } = await import(
    pathToFileURL(moduleFile)
  );
  const registry = new SqliteDatabaseAdmissionRegistry();
  const databaseCount = 40;
  const scopeCount = 1000;
  const backingStores = new Set();
  for (let index = 0; index < databaseCount; index++) {
    const references = new SharedArrayBuffer(8);
    Atomics.store(new Int32Array(references), 0, 1);
    const record = {
      identity: `synthetic-${index}`,
      physicalIdentity: { key: `file:1:${index + 1}` },
      location: `/synthetic/database-${index}.sqlite`,
      descriptor: -1,
      descriptorOwner: 0,
      generationId: `generation-${index}`,
      generation: new SharedArrayBuffer(36),
      writerDiagnostic: new Int32Array(new SharedArrayBuffer(500)),
      writeScopes: new Map(),
      writeScopeRevision: 0,
      references: new Map([[0, references]]),
      facts: new Map(),
    };
    registry.records.set(record.identity, record);
    const receipts = createSqliteDatabaseWriteReceipts({
      pathAdmission: () => record,
      publish: (current, keys) => registry.publish(current, keys),
    });
    receipts.readSqliteDatabaseScopedWriteTokensForPath(
      record.location,
      Array.from({ length: scopeCount }, (_, scope) => `session-${scope}`),
    );
    for (const revision of record.writeScopes.values()) {
      backingStores.add(revision.state.buffer);
    }
  }
  const workerFile = path.join(scratch, "worker.mjs");
  writeFileSync(
    workerFile,
    `
    import { parentPort, getEnvironmentData } from "node:worker_threads";
    import { Session } from "node:inspector/promises";
    import { SqliteDatabaseAdmissionRegistry, SQLITE_DATABASE_ADMISSIONS_KEY } from "./owners.mjs";
    const registry = new SqliteDatabaseAdmissionRegistry();
    registry.install(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY));
    const inspector = new Session(); inspector.connect();
    await inspector.post("HeapProfiler.collectGarbage");
    const scopes = [...registry.records.values()][0].writeScopes;
    const entry = [...scopes].find(([, revision]) => revision.state.byteOffset > 0) ?? [...scopes][0];
    Atomics.add(entry[1].state, 0, 1);
    parentPort.postMessage({ heap: process.memoryUsage().heapUsed, scope: entry[0] });
    parentPort.on("message", () => {});
  `,
  );
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.collectGarbage");
  const before = process.memoryUsage().rss;
  const workers = [];
  const started = performance.now();
  try {
    const samples = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise((resolve, reject) => {
            const worker = new Worker(workerFile);
            workers.push(worker);
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      ),
    );
    const startupMs = performance.now() - started;
    await inspector.post("HeapProfiler.collectGarbage");
    assert(samples.every((sample) => sample.scope === samples[0].scope));
    assert.equal(
      Atomics.load([...registry.records.values()][0].writeScopes.get(samples[0].scope).state, 0),
      workers.length,
    );
    console.log(
      JSON.stringify({
        sourceHash: createHash("sha256").update(receiptsSource).digest("hex"),
        databaseCount,
        scopeCount,
        workerCount: workers.length,
        backingStores: backingStores.size,
        workerHeap: samples.reduce((total, sample) => total + sample.heap, 0),
        rssDelta: process.memoryUsage().rss - before,
        startupMs,
      }),
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
