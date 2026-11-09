/**
 * Real Gateway plugin-migration confirmation with an open native shared-state owner.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/plugin-startup-migration-readiness-measure.ts \
 *   --state-dir /scratch/synthetic-plugin-startup --shared-mib 128
 * Reuse only this script's fixture with --reuse. Alternate fresh-process A/A and
 * baseline/candidate runs externally; --owner selects saved source beside the
 * original module so its relative imports stay identical. No plugin obligations
 * are seeded. Setup, imports, checkpointing, and cleanup are outside measurement.
 * Allocation is the main isolate's exact V8 counter, not all worker allocations.
 * Sampled peak RSS covers the measured interval; process maxRSS also includes setup.
 * Acceptance: identical empty-obligation result, zero native backups, lower owner
 * wall time/CPU/allocation without increased memory. This is not a full Gateway boot.
 */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, hostname, loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isPostgresSqlConnection } from "../../src/infra/sql-connection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "shared-mib": { type: "string", default: "128" },
    owner: { type: "string" },
    reuse: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir is required; use a disposable synthetic fixture");
assert(globalThis.gc, "Run with --expose-gc");
const sharedMiB = parseStrictIntegerOption({
  raw: values["shared-mib"],
  fallback: 128,
  min: 1,
  label: "--shared-mib",
});
const stateDir = path.resolve(values["state-dir"]);
const markerPath = path.join(stateDir, "plugin-startup-migration-readiness.fixture");
const marker = `synthetic-plugin-startup-migration-readiness-v1\nsharedMiB=${sharedMiB}\n`;
if (values.reuse) {
  assert.equal(readFileSync(markerPath, "utf8"), marker, "Fixture identity or size mismatch");
} else {
  assert(!existsSync(stateDir), "Fresh --state-dir must not exist; use --reuse for owned fixtures");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}
const scratch = path.join(stateDir, "scratch");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  TMPDIR: scratch,
};
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, env);
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/plugins/plugin-state-migration-readiness.ts", import.meta.url);
const ownerSourceSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const [owner, state, native, statements, roles, lifecycle, snapshots] = await Promise.all([
  import(ownerUrl.href) as Promise<
    typeof import("../../src/plugins/plugin-state-migration-readiness.js")
  >,
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/node-sqlite.js"),
  import("../../src/infra/kysely-sync-cache-state.js"),
  import("../../src/infra/database-engine/admission-scope.js"),
  import("../../src/infra/worker-native-lifecycle.js"),
  import("../../src/infra/sqlite-readonly-location-cleanup.js"),
]);
roles.installDatabaseProcessRole("gateway");

function allocatedBytes(): number {
  const allocated = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  assert(typeof allocated === "number", "Node with V8 total_allocated_bytes is required");
  return allocated;
}

const sqlite = native.requireNodeSqlite();
const originalBackup = sqlite.backup;
let backupCount = 0;
let backupBytes = 0;
try {
  const database = state.openOpenClawStateDatabase({ env });
  assert(!isPostgresSqlConnection(database.db), "This benchmark requires SQLite");
  if (!values.reuse) {
    // Unique deterministic ciphertext prevents compression/deduplication from hiding I/O.
    const cipher = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16));
    const insert = database.db.prepare(
      "INSERT INTO diagnostic_events(scope, event_key, payload_json, created_at) VALUES ('startup-readiness-benchmark', ?, ?, 1)",
    );
    try {
      for (let offset = 0; offset < sharedMiB; offset += 32) {
        state.runOpenClawStateWriteTransaction(
          () => {
            for (let index = offset; index < Math.min(offset + 32, sharedMiB); index++) {
              const payload = cipher.update(Buffer.alloc(768 * 1024)).toString("base64");
              insert.run(String(index), JSON.stringify(payload));
            }
          },
          { env, database },
          { operationLabel: "startup-readiness-benchmark.seed" },
        );
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } finally {
      statements.disposeSqliteStatement(insert);
    }
    writeFileSync(markerPath, marker, { flag: "wx" });
  }
  database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const databaseBytes = statSync(database.path).size;
  sqlite.backup = async (...args: Parameters<typeof originalBackup>) => {
    backupCount++;
    backupBytes += databaseBytes;
    return originalBackup(...args);
  };
  globalThis.gc();
  await nextTurn();
  const memoryBefore = process.memoryUsage();
  let sampledPeakRssBytes = memoryBefore.rss;
  const sampleRss = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss());
  };
  const timer = setInterval(sampleRss, 10);
  const loadBefore = loadavg();
  const allocatedBefore = allocatedBytes();
  const processCpuBefore = process.cpuUsage();
  const mainCpuBefore = process.threadCpuUsage();
  const started = performance.now();
  try {
    await owner.confirmPluginStateMigrationReadiness({
      config: {},
      env,
      signal: new AbortController().signal,
      warn(message) {
        throw new Error(`Unexpected empty-fixture diagnostic: ${message}`);
      },
    });
  } finally {
    clearInterval(timer);
  }
  const wallMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(mainCpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const mainAllocatedBytes = allocatedBytes() - allocatedBefore;
  sampleRss();
  const result = {
    workload: "plugin startup confirmation, no migration obligations, open native owner",
    node: process.version,
    host: hostname(),
    availableParallelism: availableParallelism(),
    owner: ownerUrl.href,
    ownerSourceSha256,
    stateDir,
    reusedFixture: values.reuse,
    sharedMiB,
    databaseBytes,
    operations: 1,
    backupCount,
    backupBytes,
    wallMs,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    mainAllocatedBytes,
    sampledPeakRssBytes,
    processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    loadBefore,
    loadAfter: loadavg(),
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    writeFileSync(values.output, output);
  }
  process.stdout.write(output);
} finally {
  sqlite.backup = originalBackup;
  await state.closeOpenClawStateDatabaseAsync();
  await snapshots.cleanupSnapshotOperations();
  await lifecycle.closeDefaultRetainedNativeWorkerSource();
}
