// node --import ./scripts/tsx.mjs scripts/perf/doctor-captured-pass.mts seed
//   --source-root <source> --scratch-root <scratch> --fixture-dir <owned-new-dir> [--bytes 134217728]
// node --import ./scripts/tsx.mjs scripts/perf/doctor-captured-pass.mts run
//   --source-root <driver-source> --runtime-root <built-capsule> --scratch-root <scratch>
//   --fixture-dir <copy> --output <dir>
// The caller owns fixture copies, timing/disk locks, observers, profiles, and cleanup.
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { UpdateStepResult } from "../../src/infra/update-step-result.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "source-root": { type: "string" },
    "runtime-root": { type: "string" },
    "scratch-root": { type: "string" },
    "fixture-dir": { type: "string" },
    output: { type: "string" },
    bytes: { type: "string", default: String(128 * 1024 ** 2) },
  },
});
const mode = positionals[0];
assert.ok(positionals.length === 1 && (mode === "seed" || mode === "run"));
assert.ok(
  values["source-root"] && values["scratch-root"] && values["fixture-dir"],
  "Source, scratch root, and fixture are required",
);
const sourceRoot = fs.realpathSync(values["source-root"]);
const runtimeRoot = fs.realpathSync(values["runtime-root"] ?? sourceRoot);
const ownedRoot = fs.realpathSync(values["scratch-root"]);
assert.notEqual(ownedRoot, path.parse(ownedRoot).root, "Scratch must be a dedicated directory");
assert.notEqual(ownedRoot, os.homedir(), "Scratch must not be the user home");
for (const root of [sourceRoot, runtimeRoot]) {
  assert.ok(
    ownedRoot !== root && !ownedRoot.startsWith(`${root}${path.sep}`),
    "Scratch must be separate from source and runtime",
  );
}
const liveState = path.resolve(
  process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"),
);
assert.ok(
  ownedRoot !== liveState && !ownedRoot.startsWith(`${liveState}${path.sep}`),
  "Scratch must not be inside live state",
);
function ownedPath(value: string): string {
  const resolved = path.resolve(value);
  assert.ok(resolved.startsWith(`${ownedRoot}${path.sep}`), "Path must be inside --scratch-root");
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    existing = path.dirname(existing);
  }
  const physical = fs.realpathSync(existing);
  assert.ok(
    physical === ownedRoot || physical.startsWith(`${ownedRoot}${path.sep}`),
    "Scratch must not escape through a symlink",
  );
  return resolved;
}
const fixture = ownedPath(values["fixture-dir"]);
const state = path.join(fixture, "state");
const home = path.join(fixture, "home");
const configPath = path.join(state, "openclaw.json");
const manifestPath = path.join(fixture, "fixture.json");
const output = values.output ? ownedPath(values.output) : undefined;
if (mode === "seed") {
  fs.mkdirSync(fixture);
  for (const directory of [state, home, path.join(fixture, "tmp")]) {
    fs.mkdirSync(directory);
  }
} else {
  assert.ok(output, "Run requires --output");
  for (const entry of ["dist", "dist-runtime", "package.json", "node_modules"]) {
    assert.ok(fs.existsSync(path.join(runtimeRoot, entry)), `Incomplete runtime: ${entry}`);
  }
  for (const location of [
    fixture,
    state,
    home,
    configPath,
    manifestPath,
    path.join(fixture, "tmp"),
  ]) {
    assert.ok(fs.existsSync(location), `Missing synthetic fixture component: ${location}`);
    ownedPath(location);
  }
  fs.mkdirSync(output, { recursive: true });
}

// Preserve measurement transport, never inherited credentials or live configuration.
const isolatedEnv: NodeJS.ProcessEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  if (
    ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "NODE_OPTIONS"].includes(name) ||
    name.startsWith("SQLMEASURE_")
  ) {
    isolatedEnv[name] = value;
  }
  delete process.env[name];
}
Object.assign(process.env, isolatedEnv, {
  HOME: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_PROFILE: "qa-doctorgen",
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  TMPDIR: path.join(fixture, "tmp"),
  TMP: path.join(fixture, "tmp"),
  TEMP: path.join(fixture, "tmp"),
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "reported-checks",
});
const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const {
  installDatabaseProcessRole,
}: typeof import("../../src/infra/database-engine/admission-scope.js") = await load(
  "src/infra/database-engine/admission-scope.ts",
);
installDatabaseProcessRole("cli-oneshot");
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
}: typeof import("../../src/state/openclaw-agent-db.js") = await load(
  "src/state/openclaw-agent-db.ts",
);
const {
  prepareOpenClawStateDatabaseSchema,
  closeOpenClawStateDatabaseAsync,
}: typeof import("../../src/state/openclaw-state-db.js") = await load(
  "src/state/openclaw-state-db.ts",
);
const {
  closeDefaultRetainedNativeWorkerSource,
}: typeof import("../../src/infra/worker-native-lifecycle.js") = await load(
  "src/infra/worker-native-lifecycle.ts",
);
const { closePostgresPool }: typeof import("../../src/infra/postgres-sync/pool.js") = await load(
  "src/infra/postgres-sync/pool.ts",
);
const result: Record<string, unknown> = { mode, node: process.version, load: os.loadavg() };
try {
  if (mode === "seed") {
    await seed();
  } else {
    await run();
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  for (const close of [
    closeOpenClawStateDatabaseAsync,
    closeOpenClawAgentDatabasesAsync,
    closeDefaultRetainedNativeWorkerSource,
    closePostgresPool,
  ]) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (cleanupErrors.length > 0) {
    result.ok = false;
    result.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
  }
  const json = JSON.stringify(result, null, 2);
  if (output) {
    fs.writeFileSync(path.join(output, "direct-result.json"), json, { flag: "wx" });
  }
  console.log(json);
}

async function seed() {
  const target = Number(values.bytes);
  assert.ok(Number.isSafeInteger(target) && target > 0, "--bytes must be a positive integer");
  const agents = ["main", "reviewer", "researcher", "planner"];
  const sessionsPerAgent = 1024;
  const config: OpenClawConfig = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 45771,
      auth: { mode: "token", token: "qa-doctorgen-synthetic" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    discovery: { mdns: { mode: "off" } },
    browser: { enabled: false },
    cron: { enabled: false },
    update: { checkOnStart: false },
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: Object.fromEntries(
        agents.map((agentId) => [
          agentId,
          {
            workspace: `~/workspace/${agentId}`,
          },
        ]),
      ),
    },
    logging: { file: "~/gateway.log" },
  };
  const { validateConfigObjectRaw }: typeof import("../../src/config/validation-core.js") =
    await load("src/config/validation-core.ts");
  assert.ok(validateConfigObjectRaw(config).ok, "Synthetic configuration must validate");
  for (const agentId of agents) {
    fs.mkdirSync(path.join(home, "workspace", agentId), { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
  const {
    writeSessionEntry,
  }: typeof import("../../src/config/sessions/session-accessor.sqlite-entry-store.js") = await load(
    "src/config/sessions/session-accessor.sqlite-entry-store.ts",
  );
  const {
    appendTranscriptEventsInTransaction,
  }: typeof import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js") =
    await load("src/config/sessions/session-accessor.sqlite-transcript-store.ts");
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const databases = agents.map((agentId) => openOpenClawAgentDatabase({ agentId }));
  const identity = (agentId: string, index: number) => ({
    agentId,
    sessionId: `synthetic-${agentId}-${index}`,
    sessionKey: `agent:${agentId}:doctorgen-${index}`,
  });
  for (const agentId of agents) {
    for (let offset = 0; offset < sessionsPerAgent; offset += 128) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = offset; index < offset + 128; index++) {
            const session = identity(agentId, index);
            writeSessionEntry(database, session.sessionKey, {
              sessionId: session.sessionId,
              updatedAt: now,
              createdAt: now,
              sessionStartedAt: now,
              lastInteractionAt: now,
              lastActivityAt: now,
              lifecycleRevision: "synthetic-v1",
              label: "Synthetic Doctor fixture",
              status: "done",
              createdVia: "operator",
            });
            appendTranscriptEventsInTransaction(database, session, [
              { type: "session", version: 3, id: session.sessionId, timestamp },
            ]);
          }
        },
        { agentId },
      );
    }
  }
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("doctorgen-v1").digest(),
    Buffer.alloc(16),
  );
  const checkpointBytes = () =>
    databases.reduce((bytes, database) => {
      database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return bytes + fs.statSync(database.path).size;
    }, 0);
  let messages = 0;
  let actualDatabaseBytes = checkpointBytes();
  while (actualDatabaseBytes < target) {
    for (let count = 0; count < 128; count++) {
      const agentId = agents[messages % agents.length]!;
      const session = identity(agentId, Math.floor(messages / agents.length) % sessionsPerAgent);
      const text = cipher.update(Buffer.alloc(192 * 1024)).toString("base64");
      runOpenClawAgentWriteTransaction(
        (database) =>
          appendTranscriptEventsInTransaction(database, session, [
            {
              type: "message",
              id: `size-${messages}`,
              parentId: null,
              timestamp,
              message: { role: "user", content: [{ type: "text", text }], timestamp: now },
            },
          ]),
        { agentId },
      );
      messages++;
    }
    actualDatabaseBytes = checkpointBytes();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  const prepared = await prepareOpenClawStateDatabaseSchema({ env: process.env }, "doctor");
  assert.deepEqual(prepared.warnings, [], "Seed schema preparation must succeed");
  const manifest = {
    kind: "openclaw-doctorgen-synthetic-v1",
    agentCount: agents.length,
    sessionCount: agents.length * sessionsPerAgent,
    messages,
    actualDatabaseBytes,
    targetBytes: target,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  Object.assign(result, manifest);
}

async function run() {
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(
    manifest &&
      typeof manifest === "object" &&
      "kind" in manifest &&
      manifest.kind === "openclaw-doctorgen-synthetic-v1",
    "Expected this workload's synthetic fixture",
  );
  const {
    withUpdateCommandExecutor,
  }: typeof import("../../src/cli/update-cli/update-command-executor.js") = await load(
    "src/cli/update-cli/update-command-executor.ts",
  );
  const {
    createUpdateRun,
    adoptUpdateRun,
    finishUpdateRun,
    getUpdateRun,
  }: typeof import("../../src/infra/update-run-ledger.js") = await load(
    "src/infra/update-run-ledger.ts",
  );
  const {
    captureUpdateRecoveryBaseline,
  }: typeof import("../../src/infra/update-recovery-baseline-capture.js") = await load(
    "src/infra/update-recovery-baseline-capture.ts",
  );
  const { readUpdateRunDriver }: typeof import("../../src/infra/update-run-driver.js") = await load(
    "src/infra/update-run-driver.ts",
  );
  const {
    captureUpdateDatabases,
  }: typeof import("../../src/cli/update-cli/update-command-database-backup.js") = await load(
    "src/cli/update-cli/update-command-database-backup.ts",
  );
  const {
    createUpdateCommandExecutionGuards,
  }: typeof import("../../src/cli/update-cli/update-command-execution-guards.js") = await load(
    "src/cli/update-cli/update-command-execution-guards.ts",
  );
  const {
    runPackageUpdateDoctor,
  }: typeof import("../../src/cli/update-cli/update-command-package.js") = await load(
    "src/cli/update-cli/update-command-package.ts",
  );
  const {
    readUpdateConfigSnapshot,
  }: typeof import("../../src/cli/update-cli/update-command-config-snapshot.js") = await load(
    "src/cli/update-cli/update-command-config-snapshot.ts",
  );
  const runId = randomUUID();
  const steps: UpdateStepResult[] = [];
  Object.assign(result, { runId, fixture: manifest, steps });
  await withUpdateCommandExecutor(runId, async (executor) => {
    const executorFence = await executor.enter(runtimeRoot);
    createUpdateRun({ runId, trigger: "cli", origin: { admission: { owner: "installed" } } });
    assert.ok(adoptUpdateRun(runId).origin.driver, "Native driver adoption must succeed");
    const driver = readUpdateRunDriver();
    assert.ok(driver);
    await closeOpenClawStateDatabaseAsync();
    const captured = await captureUpdateRecoveryBaseline({
      runId,
      installRoot: runtimeRoot,
      env: process.env,
      drivers: [driver],
      assertCurrent: () => executorFence.assertCurrent(),
      nodeRunner: process.execPath,
      timeoutMs: 30 * 60_000,
    });
    result.captureWarnings = captured.warnings.map(({ kind, pluginId }) => ({ kind, pluginId }));
    const updateRun = {
      runId,
      env: { ...process.env },
      executorFence,
      originalRecoveryCapture: captured.ref,
    };
    const guards = createUpdateCommandExecutionGuards(
      { yes: true, json: true, restart: true, run: updateRun },
      runtimeRoot,
    );
    const capturedDatabases = await captureUpdateDatabases({
      transaction: {
        backupRoot: path.join(fixture, "backups", runId),
        rollback: async () => {
          throw new Error("Unexpected workload rollback");
        },
        complete: async () => {
          throw new Error("Unexpected workload completion");
        },
      },
      execution: {
        root: runtimeRoot,
        installKind: "git",
        updateInstallKind: "git",
        switchToGit: false,
        timeoutMs: undefined,
        updateStepTimeoutMs: 30 * 60_000,
        startedAt: Date.now(),
        progress: {},
        executionGuards: guards,
        stop: () => {},
        channel: "dev",
        tag: "dev",
        opts: { yes: true, json: true, restart: true, run: updateRun },
        shouldRestart: true,
        packageInstallSpec: null,
        packageUpdateNodeRunner: process.execPath,
        managedServiceRootRedirect: null,
        recoveryState: { triageTarget: { root: runtimeRoot, env: process.env } },
        prepareMutableUpdate: async () => {
          throw new Error("Unexpected workload activation");
        },
      },
      context: undefined,
      assertCurrent: () => executorFence.assertCurrent(),
    });
    const databaseBackup = capturedDatabases.backup;
    assert.ok(databaseBackup, "Production capture must retain automatic restoration");
    assert.deepEqual(databaseBackup.warnings, [], "Database capture must succeed");
    assert.ok(databaseBackup.databases.length > 0, "Capture must contain existing databases");
    assert.ok(
      databaseBackup.databases.every(
        (entry) => typeof databaseBackup.sourceGenerations[entry.path] === "string",
      ),
      "Every captured database must have a generation baseline",
    );
    const snapshot = await readUpdateConfigSnapshot(configPath);
    const started = performance.now();
    const cpu = process.cpuUsage();
    const doctor = await runPackageUpdateDoctor({
      root: runtimeRoot,
      restart: true,
      managedServiceEnv: process.env,
      nodeRunner: process.execPath,
      workTimeoutMs: null,
      progress: {},
      results: steps,
      getDoctorContext: () => ({
        runId,
        executorFence,
        inputHash: snapshot.hash,
        changes: [],
        databaseBackup,
        originalRecoveryCapture: captured.ref,
        ...guards,
      }),
    });
    Object.assign(result, {
      doctor,
      diagnosticDoctorMs: performance.now() - started,
      doctorParentCpuMicros: process.cpuUsage(cpu),
      ledgerSteps: getUpdateRun(runId)?.steps,
    });
    assert.ok(doctor && (doctor.exitCode === 0 || doctor.exitCode === 86), "Doctor must complete");
    assert.ok(!doctor.configWriteRefusal && !doctor.failureFacts?.length, "Doctor must not refuse");
    assert.ok(!databaseBackup.restoreRefusal, "Doctor must retain restoration attribution");
    result.capture = {
      databases: databaseBackup.databases.length,
      generations: Object.keys(databaseBackup.sourceGenerations).length,
      snapshotBytes: databaseBackup.databases.reduce(
        (bytes, database) => bytes + database.sizeBytes,
        0,
      ),
      migration: Boolean(databaseBackup.migration),
    };
    finishUpdateRun(runId, { status: "succeeded" });
  });
}
