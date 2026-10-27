// Exact owner publication proof over synthetic records; no native SQLite or Gateway claims.
// install-scope-reference follows each scope import with a reference-only install, using
// 40 databases with 1,000 session/context keys. Example (also use allocation or counts):
// node --expose-gc scripts/perf/sqlite-admission-release-measure.mjs "$PWD" \
//   src/infra/sqlite-database-admission-record.ts candidate timing 3000 100 1 install-scope-reference
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getEnvironmentData } from "node:worker_threads";

const [
  sourceRoot,
  ownerFile,
  label = "owner",
  mode = "timing",
  count = "1000",
  warmupCount = "50",
  touchedCount,
  operation = "release",
] = process.argv.slice(2);
assert(
  sourceRoot && ownerFile,
  "usage: node --expose-gc SCRIPT SOURCE_ROOT OWNER_FILE LABEL [timing|allocation|counts] [OPERATIONS] [WARMUP] [TOUCHED] [release|install|install-scope|install-scope-reference]",
);
assert(["timing", "allocation", "counts"].includes(mode));
assert(["release", "install", "install-scope", "install-scope-reference"].includes(operation));
assert(globalThis.gc, "--expose-gc required for cleanup outside measurement");
const operations = Number(count);
const warmup = Number(warmupCount);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(Number.isSafeInteger(operations) && operations > 0);
const root = mkdtempSync(path.join(tmpdir(), "sqlite-admission-release-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const source = readFileSync(ownerFile, "utf8");
const singleton = readFileSync(path.join(sourceRoot, "src/shared/global-singleton.ts"), "utf8");
const identity = readFileSync(path.join(sourceRoot, "src/infra/sqlite-worker-identity.ts"), "utf8");
const key = readFileSync(
  path.join(sourceRoot, "src/infra/sqlite-database-admission-key.ts"),
  "utf8",
);
const normalize = identity.slice(
  identity.indexOf("export function normalizeDatabasePath("),
  identity.indexOf("export function readDatabaseFileIdentity("),
);
assert(normalize.startsWith("export function normalizeDatabasePath("));
assert(process.platform !== "win32", "this synthetic publication proof runs on Unix hosts");
// Keep the complete owner. Native descriptor helpers are outside this workload and fail closed.
const owner = source
  .replace(/^import type .*;\n/gm, "")
  .replace(/^import \{ resolveGlobalSingleton \} from .*;\n/m, "")
  .replace(/^import \{ SQLITE_DATABASE_ADMISSIONS_KEY \} from .*;\n/m, "")
  .replace(/^import \{\n[\s\S]*?\} from "\.\/sqlite-worker-identity\.js";\n/m, "");
assert(!/from "\.\.?\//.test(owner), "owner dependency imports changed; review harness");
const code = stripTypeScriptTypes(`${singleton}\n${key}\n${normalize}\n
function unsupportedIdentityOperation() { throw new Error("native identity is outside publication proof"); }
const isSoleDatabaseFileDescriptor = unsupportedIdentityOperation;
const readDatabaseIdentityBirthtime = unsupportedIdentityOperation;
const normalizeWindowsPathPreservingCase = unsupportedIdentityOperation;
${owner}`);
const moduleFile = path.join(root, "admission-owner.mjs");
writeFileSync(moduleFile, code);
const { SqliteDatabaseAdmissionRegistry, SqliteDatabaseGenerationSlot } = await import(
  pathToFileURL(moduleFile).href
);
const databaseCount = 40;
const scopesPerDatabase = operation === "install-scope-reference" ? 1000 : 3000;
const scopeKey = (name) =>
  operation === "install-scope-reference"
    ? JSON.stringify(["session", name, "model-context"])
    : name;
const worker = 100;
function fixture() {
  const registry = new SqliteDatabaseAdmissionRegistry();
  const records = [];
  for (let i = 0; i < databaseCount; i++) {
    const refs = new SharedArrayBuffer(8);
    Atomics.store(new Int32Array(refs), 0, 1);
    const record = {
      identity: `synthetic-${i}`,
      physicalIdentity: { key: `file:1:${i + 1}` },
      location: `/synthetic/admission-${i}.sqlite`,
      descriptor: -1,
      descriptorOwner: 0,
      generationId: `generation-${i}`,
      generation: new SharedArrayBuffer(36),
      writeScopes: new Map(),
      writeScopeRevision: 0,
      references: new Map([[0, refs]]),
      facts: new Map(),
    };
    for (let j = 0; j < scopesPerDatabase; j++) {
      record.writeScopes.set(scopeKey(`session-${j}`), {
        identity: `scope-${j}`,
        state: new Int32Array(new SharedArrayBuffer(12)),
      });
    }
    registry.install([record]);
    records.push(registry.records.get(record.identity));
  }
  return { registry, records };
}
function sumAllocation(node) {
  return node.selfSize + node.children.reduce((total, child) => total + sumAllocation(child), 0);
}
const results = [];
const scenarios = touchedCount === undefined ? [0, 1, databaseCount] : [Number(touchedCount)];
assert(
  scenarios.every(
    (touched) => Number.isSafeInteger(touched) && touched >= 0 && touched <= databaseCount,
  ),
);
for (const touched of scenarios) {
  const { registry, records } = fixture();
  const targets = records.slice(0, touched);
  const refs = new SharedArrayBuffer(8);
  let installedScopes = 0;
  const run = () => {
    Atomics.store(new Int32Array(refs), 0, 1);
    if (operation === "release") {
      for (const record of targets) {
        record.references.set(worker, refs);
      }
      registry.releaseWorker(worker);
    } else {
      const incoming = targets.map((record) => {
        record.references.delete(worker);
        const writeScopes = new Map();
        if (operation.startsWith("install-scope")) {
          const scope = scopeKey(`installed-${installedScopes++}`);
          writeScopes.set(scope, {
            identity: scope,
            state: new Int32Array(new SharedArrayBuffer(12)),
          });
        }
        return { ...record, facts: new Map(), writeScopes, references: new Map([[worker, refs]]) };
      });
      registry.install(incoming);
      if (operation === "install-scope-reference") {
        registry.install(
          targets.map((record) => {
            record.references.delete(worker + 1);
            return {
              ...record,
              facts: new Map(),
              writeScopes: new Map(),
              references: new Map([[worker + 1, refs]]),
            };
          }),
        );
      }
    }
  };
  for (let i = 0; i < warmup; i++) {
    run();
  }
  let visits = 0;
  let publications = 0;
  if (mode === "counts") {
    for (const record of records) {
      const original = record.writeScopes.forEach;
      record.writeScopes.forEach = function (callback, thisArg) {
        return original.call(this, (value, scope, map) => {
          visits++;
          callback.call(thisArg, value, scope, map);
        });
      };
    }
    const publish = registry.publish;
    registry.publish = function (...args) {
      publications++;
      return publish.apply(this, args);
    };
  }
  globalThis.gc();
  await yieldTurn();
  const barrier = process.env.ADMISSION_MEASURE_START_DIR;
  if (barrier) {
    writeFileSync(path.join(barrier, `${touched}.${label}.ready`), "ready");
    const startFile = path.join(barrier, `${touched}.start`);
    while (!existsSync(startFile)) {
      await delay(20);
    }
    const startAt = Number(readFileSync(startFile, "utf8"));
    while (Date.now() < startAt) {
      await delay(Math.min(20, startAt - Date.now()));
    }
  }
  const gc = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.push({ duration: entry.duration, kind: entry.detail.kind, start: entry.startTime });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < operations; i++) {
    run();
  }
  const elapsedMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  const end = performance.now();
  const profile = inspector ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  inspector?.disconnect();
  await yieldTurn();
  await yieldTurn();
  observer.disconnect();
  for (const record of records) {
    assert.equal(
      record.references.has(worker),
      operation !== "release" && targets.includes(record),
    );
    assert.equal(
      Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.retired),
      0,
    );
  }
  if (touched > 0) {
    assert.equal(Atomics.load(new Int32Array(refs), 0), operation === "release" ? -1 : 1);
  }
  const snapshot = getEnvironmentData("openclaw.sqliteDatabaseAdmissions.v1");
  assert.equal(snapshot.length, databaseCount);
  assert.equal(
    snapshot.filter((record) => record.references.has(worker)).length,
    operation !== "release" ? touched : 0,
  );
  if (operation.startsWith("install-scope") && touched > 0) {
    assert(
      snapshot.some((record) =>
        record.writeScopes.has(scopeKey(`installed-${installedScopes - 1}`)),
      ),
    );
  }
  const measuredGC = gc.filter((entry) => entry.start >= start && entry.start <= end);
  results.push({
    touched,
    operations,
    scopeVisits: mode === "counts" ? visits : undefined,
    publications: mode === "counts" ? publications : undefined,
    elapsedMs,
    cpuMs: (usage.user + usage.system) / 1000,
    allocationBytes: profile ? sumAllocation(profile.profile.head) : undefined,
    allocationSamples: profile?.profile.samples.length,
    gc: {
      count: measuredGC.length,
      totalMs: measuredGC.reduce((sum, entry) => sum + entry.duration, 0),
      maxMs: Math.max(0, ...measuredGC.map((entry) => entry.duration)),
      byKind: Object.fromEntries(
        [1, 2, 4, 8].map((kind) => [
          kind,
          measuredGC
            .filter((entry) => entry.kind === kind)
            .reduce((sum, entry) => sum + entry.duration, 0),
        ]),
      ),
    },
  });
}
// Final native-reader retirement retains its original shared revocation semantics.
const { registry, records } = fixture();
const last = records[0];
const refs = new SharedArrayBuffer(8);
Atomics.store(new Int32Array(refs), 0, 1);
last.references.clear();
last.references.set(worker, refs);
registry.releaseWorker(worker);
assert.equal(Atomics.load(new Int32Array(refs), 0), -1);
assert.equal(
  Atomics.load(new Int32Array(last.generation), SqliteDatabaseGenerationSlot.retired),
  2,
);
assert(!registry.records.has(last.identity));
console.log(
  JSON.stringify({
    label,
    mode,
    operation,
    node: process.version,
    platform: process.platform,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    dependenciesSha256: Object.fromEntries(
      Object.entries({ singleton, normalize, key }).map(([name, value]) => [
        name,
        createHash("sha256").update(value).digest("hex"),
      ]),
    ),
    databaseCount,
    warmup,
    scopesPerDatabase,
    load: loadavg(),
    results,
    finalReaderRetirement: "passed",
    limitation:
      "synthetic owner publication only; reference reattachment excluded from admission protocol; no Gateway, native SQL, latency-tail, or promotion claim",
  }),
);
