/**
 * Isolated agent-database startup proof, not whole-Gateway readiness or a load test.
 * Run each command in a fresh process, using the same source revision as its owners:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-startup-inspection.ts
 *   seed --state-dir "$PWD/.local/startup-proof" --gib 2.5
 *   inspect --state-dir ... --policy foreground
 *   inspect --state-dir ... --policy background [--allocations]
 *   overload --state-dir ... [--owner <historical-startup-module>] [--failures 1]
 *     Measures real deferred admission with a rejected migration callback. It does
 *     not run a Gateway, model publication, or background integrity verification.
 *   crash --state-dir ...       # deliberately SIGKILLs only this fixture writer
 *   corrupt --state-dir ...     # damages only the marked fixture's cache root page
 *
 * Seed writes 10,000 real sessions, then bulk-fills canonical transcript rows with
 * deterministic incompressible payloads to the requested actual database size.
 * complete-seed resumes only a marked incomplete seed after its writer has stopped.
 * Inspect reports admission readiness separately from full-verification completion.
 * CPU/allocation measurements cover the host owner; native child-process CPU and
 * allocation are not included. Timing and allocation passes must be separate.
 * Compare actual base/candidate source revisions; foreground policy on candidate is
 * only a policy control. A corruption verdict must refuse subsequent writes.
 * The state directory must be new for seed and carry this script's marker thereafter.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    gib: { type: "string", default: "2.5" },
    policy: { type: "string", default: "background" },
    owner: { type: "string" },
    failures: { type: "string", default: "1" },
    allocations: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "agent-startup-inspection.ts <seed|complete-seed|inspect|overload|crash|corrupt> --state-dir <new-fixture> [--gib 2.5] [--policy foreground|background] [--owner <startup-module>] [--failures 1] [--allocations]",
  );
  process.exit(0);
}
const command = positionals[0];
assert(
  positionals.length === 1 &&
    ["seed", "complete-seed", "inspect", "overload", "crash", "corrupt"].includes(command!),
);
assert(values["state-dir"], "--state-dir is required");
assert(values.policy === "foreground" || values.policy === "background");
assert(!values.owner || command === "overload", "--owner requires overload mode");
const gib = Number(values.gib);
assert(Number.isFinite(gib) && gib >= 2 && gib <= 40, "--gib must be 2..40");
const root = fileURLToPath(new URL("../../", import.meta.url));
const stateDir = path.resolve(values["state-dir"]);
const markerPath = path.join(stateDir, ".agent-startup-inspection.json");
const databasePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
const marker = "openclaw-agent-startup-inspection-v1";
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
  });
const digest = createHash("sha256").update(git("diff", "HEAD", "--", "src"));
for (const filename of git("ls-files", "--others", "--exclude-standard", "src")
  .trim()
  .split("\n")
  .filter(Boolean)
  .toSorted()) {
  digest.update(filename).update(readFileSync(path.join(root, filename)));
}
const revision = { head: git("rev-parse", "HEAD").trim(), sourceDiffSha256: digest.digest("hex") };

if (command === "seed") {
  const { generateTeamShapeFixture, parseTeamShapeOptions } =
    await import("./team-shape-fixture.ts");
  const { summary } = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      stateDir,
      "--sessions",
      "10000",
      "--runs",
      "0",
      "--agents",
      "1",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      "0",
      "--transcript-mib",
      "0",
    ]),
  );
  writeFileSync(
    markerPath,
    JSON.stringify({ marker, databasePath, summary, revision, seedIncomplete: true }),
  );
}

const fixture = JSON.parse(readFileSync(markerPath, "utf8"));
assert(fixture.marker === marker, "Only this script's synthetic state may be opened or damaged");
if (command === "seed" || command === "complete-seed") {
  assert(fixture.seedIncomplete === true, "Only a marked incomplete seed can be filled");
  const { invalidateSqliteDatabaseCleanClose } =
    await import("../../src/infra/sqlite-database-admission.js");
  invalidateSqliteDatabaseCleanClose(databasePath);
  using database = new DatabaseSync(databasePath);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0");
  const sessions = database
    .prepare("SELECT session_id FROM session_windows ORDER BY session_id")
    .all();
  assert.equal(sessions.length, 10_000, "Seed requires 10,000 existing session windows");
  const sequences = new Map(
    database
      .prepare("SELECT session_id, max(seq) AS seq FROM transcript_events GROUP BY session_id")
      .all()
      .map((row) => [String(row.session_id), Number(row.seq)]),
  );
  const event = database.prepare(
    "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
  );
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("startup-overload-fixture").digest(),
    Buffer.alloc(16),
  );
  const zeros = Buffer.alloc(32 * 1024);
  const target = gib * 1024 ** 3;
  const pageSize = Number(database.prepare("PRAGMA page_size").get()!.page_size);
  const bytes = () => Number(database.prepare("PRAGMA page_count").get()!.page_count) * pageSize;
  let rows = 0;
  while (bytes() < target) {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 1_000; index++, rows++) {
        const sessionId = String(sessions[rows % sessions.length]!.session_id);
        const seq = (sequences.get(sessionId) ?? 0) + 1;
        sequences.set(sessionId, seq);
        const payload = JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: cipher.update(zeros).toString("base64") }],
          },
        });
        event.run(sessionId, seq, payload);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (rows % 50_000 === 0) {
      console.log(JSON.stringify({ phase: "seed-fill", rows, databaseBytes: bytes() }));
    }
  }
  const summary = {
    ...fixture.summary,
    agentDatabaseBytes: bytes(),
    transcriptEvents: Number(
      database.prepare("SELECT count(*) AS count FROM transcript_events").get()!.count,
    ),
    bulkRowsAdded: rows,
  };
  database.close();
  writeFileSync(markerPath, JSON.stringify({ ...fixture, seedIncomplete: false, summary }));
  console.log(JSON.stringify({ command, revision, ...summary }));
  process.exit(0);
}
assert(fixture.seedIncomplete !== true, "Finish the marked seed before measuring");
assert(statSync(databasePath).size >= 2 * 1024 ** 3, "Database must be >=2 GiB");
const cacheDir = path.join(
  os.tmpdir(),
  `startup-inspection-${createHash("sha256").update(stateDir).digest("hex").slice(0, 12)}`,
);
mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), path.join(stateDir, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: stateDir,
  XDG_CACHE_HOME: cacheDir,
};
const { applyLoggingConfig } = await import("../../src/logging/logger.js");
applyLoggingConfig({
  level: "info",
  consoleLevel: "silent",
  file: path.join(stateDir, "owner.log"),
});
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const admission = await import("../../src/infra/sqlite-database-admission.js");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const options = { agentId: "main", path: databasePath, env: process.env };

if (command === "corrupt") {
  const db = openNodeSqliteDatabase(databasePath);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  const rootPage = Number(
    db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='cache_entries'").get()!.rootpage,
  );
  db.close();
  assert(rootPage > 1 && pageSize >= 512);
  admission.invalidateSqliteDatabaseCleanClose(databasePath);
  const fd = openSync(databasePath, "r+");
  try {
    writeSync(fd, Buffer.from([0xff]), 0, 1, (rootPage - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
  writeFileSync(markerPath, JSON.stringify({ ...fixture, corrupted: true }));
  console.log(JSON.stringify({ command, revision, corruptionOffset: (rootPage - 1) * pageSize }));
  process.exit(0);
}

if (command === "crash") {
  const database = agent.openOpenClawAgentDatabase(options);
  database.db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
  agent.runOpenClawAgentWriteTransaction(({ db }) => {
    db.prepare(
      "INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES('startup-proof','committed-wal','{}',1) ON CONFLICT(scope,key) DO UPDATE SET updated_at=updated_at+1",
    ).run();
  }, options);
  const walBytes = statSync(`${databasePath}-wal`).size;
  assert(walBytes > 0 && walBytes < 1024 ** 2, "Crash must leave a small committed WAL");
  writeFileSync(path.join(stateDir, "crash.json"), JSON.stringify({ command, revision, walBytes }));
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}

const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/state/agent-database-startup.ts", import.meta.url);
const { withAgentDatabaseStartupAdmission } = (await import(
  ownerUrl.href
)) as typeof import("../../src/state/agent-database-startup.js");
const ownerSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const { WorkerTaskError } = await import("../../src/infra/worker-task-pool.js");
const {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} = await import("../../src/state/agent-database-admission.js");
const { assertOpenClawDatabasesReady } =
  await import("../../src/state/openclaw-database-preflight.js");
const { prepareOpenClawAgentDatabaseExecution } =
  await import("../../src/state/openclaw-agent-execution.js");
const { withOpenClawStateDatabaseReadSnapshot } =
  await import("../../src/state/openclaw-state-db-readonly.js");
const config = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
setRuntimeConfigSnapshot(config);
const verificationModule = new URL(
  "../../src/state/agent-database-startup-verification.ts",
  import.meta.url,
);
const verifyIntegrity =
  command !== "overload" && values.policy === "background"
    ? (await import(verificationModule.href)).verifyAgentDatabaseStartupIntegrity
    : undefined;
const sessionCount = () => {
  using database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  return Number(database.prepare("SELECT count(*) AS count FROM session_nodes").get()!.count);
};
const sessionsBefore = command === "overload" ? sessionCount() : undefined;
const inspector = new Session();
inspector.connect();
global.gc?.();
if (values.allocations) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.threadCpuUsage();
const processCpu = process.cpuUsage();
const started = performance.now();
const before = process.memoryUsage();
const sealBefore = admission.readSqliteDatabaseCleanClose(databasePath);
let readyMs: number | undefined;
let fullMs: number | undefined;
let refusal: unknown;
let sampledAllocationBytes: number | undefined;
let writesRefused = false;
let migrationAttempts = 0;
const rejectedAttempts = Number(values.failures);
assert(Number.isSafeInteger(rejectedAttempts) && rejectedAttempts >= 0);
let settledMs: number | undefined;
try {
  await withAgentDatabaseStartupAdmission(async (startup) => {
    if (command === "overload") {
      recordAgentDatabaseAdmissions(
        startup.defer({
          env: process.env,
          inspections: [
            {
              target: { agentId: "main", path: databasePath },
              result: Promise.resolve({ incompatible: [], indeterminate: [] }),
            },
          ],
          reason: "Synthetic worker-capacity startup proof",
        }),
        { env: process.env, source: "startup" },
      );
    } else {
      await withOpenClawStateDatabaseReadSnapshot(
        () =>
          assertOpenClawDatabasesReady({ env: process.env, config, operation: "gateway-startup" }),
        { env: process.env },
      );
    }
    const owner = startup.adopt();
    try {
      startup.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: ({ assertCurrent, signal }) =>
          prepareOpenClawAgentDatabaseExecution(options, assertCurrent, signal),
        migrateAgent: async () => {
          migrationAttempts++;
          if (command === "overload" && migrationAttempts <= rejectedAttempts) {
            throw new WorkerTaskError("worker task capacity reached", "overloaded");
          }
        },
        publishAgent: async () => {},
        ...(verifyIntegrity ? { verifyIntegrity } : {}),
      });
      await startup.waitForAgentPreparation("main", { env: process.env, forWrite: true });
      settledMs = performance.now() - started;
      assertAgentDatabaseAdmitted("main", { env: process.env });
      readyMs = performance.now() - started;
      // The background task is tracked before the readiness continuation runs.
      await startup.pendingPreparation;
      fullMs = performance.now() - started;
      refusal = readAgentDatabaseAdmissionRefusal("main", { env: process.env });
      if (refusal) {
        assert.throws(() => assertAgentDatabaseAdmitted("main", { env: process.env }));
        assert.throws(() => agent.runOpenClawAgentWriteTransaction(() => {}, options));
        writesRefused = true;
      }
    } finally {
      await owner.stop();
    }
  });
} catch (error) {
  settledMs ??= performance.now() - started;
  refusal =
    readAgentDatabaseAdmissionRefusal("main", { env: process.env }) ??
    (error instanceof Error ? { name: error.name, message: error.message } : String(error));
  if (fixture.corrupted || command === "overload") {
    assert.throws(() => agent.runOpenClawAgentWriteTransaction(() => {}, options));
    writesRefused = true;
  }
} finally {
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  inspector.disconnect();
  const usedCpu = process.threadCpuUsage(cpu);
  const usedProcessCpu = process.cpuUsage(processCpu);
  const after = process.memoryUsage();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  const sealAfter = admission.readSqliteDatabaseCleanClose(databasePath);
  const sessionsAfter = command === "overload" ? sessionCount() : undefined;
  assert.equal(sessionsAfter, sessionsBefore, "Startup must preserve synthetic sessions");
  const corruptionDetected =
    /SQLite (?:integrity_check|foreign_key_check)|database disk image is malformed|file is not a database/i.test(
      JSON.stringify(refusal) ?? "",
    );
  settledMs ??= performance.now() - started;
  const passed =
    command === "overload"
      ? readyMs !== undefined && !refusal
      : fixture.corrupted
        ? corruptionDetected && writesRefused
        : readyMs !== undefined && fullMs !== undefined && !refusal && sealAfter;
  const report = {
    command,
    policy: values.policy,
    ownerSha256,
    rejectedAttempts,
    migrationAttempts,
    sessionsBefore,
    sessionsAfter,
    settledMs,
    revision,
    node: process.version,
    databaseBytes: statSync(databasePath).size,
    sealBefore,
    walBytes: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
    readyMs,
    fullMs,
    refusal,
    mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    processCpuMs: (usedProcessCpu.user + usedProcessCpu.system) / 1000,
    sampledAllocationBytes,
    before,
    after,
    hostLoad: os.loadavg(),
    sealAfter,
    expectedCorruption: fixture.corrupted === true,
    corruptionDetected,
    writesRefused,
    passed,
  };
  writeFileSync(
    path.join(stateDir, `inspection-${Date.now()}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (!passed) {
    process.exitCode = 1;
  }
}
