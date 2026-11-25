// node --import ./scripts/tsx.mjs scripts/perf/doctor-config-measure.mts fixture --fixture <fresh-dir>
// node --import ./scripts/tsx.mjs scripts/perf/doctor-config-measure.mts run --repo <built-repo> \
//   --fixture <fixture-copy> --output <fresh-dir> --observer-root <frozen-harness> [--profile]
// Copy the stopped fixture before each sample. The caller owns disk/load gates, timing locks,
// interleaved baseline/candidate sampling, frozen-observer verification, and scratch cleanup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.js";
import type { UpdateStepResult } from "../../src/infra/update-step-result.js";
import { createDoctorConfigProbe } from "./doctor-config-probe.mts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string", default: "." },
    fixture: { type: "string" },
    output: { type: "string" },
    bytes: { type: "string", default: String(1024 ** 3) },
    "observer-root": { type: "string" },
    profile: { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
  },
});
const mode = positionals[0];
assert.ok(positionals.length === 1 && (mode === "fixture" || mode === "run"));
assert.ok(values.fixture, "--fixture is required; only synthetic state may be supplied");
const root = path.resolve(values.repo);
const fixture = path.resolve(values.fixture);
const state = path.join(fixture, "state");
const configPath = path.join(state, "openclaw.json");
const agents = ["main", "reviewer", "researcher", "planner"];
const sessionsPerAgent = 1024;
const manifestPath = path.join(fixture, "fixture.json");
if (mode === "fixture") {
  fs.mkdirSync(fixture, { recursive: false });
  for (const directory of [state, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
const isolatedEnv: NodeJS.ProcessEnv = {};
for (const name of [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
]) {
  if (process.env[name]) {
    isolatedEnv[name] = process.env[name];
  }
}
Object.assign(isolatedEnv, {
  HOME: path.join(fixture, "home"),
  OPENCLAW_HOME: path.join(fixture, "home"),
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_PROFILE: "qa-doctorconfig",
  XDG_CONFIG_HOME: path.join(fixture, "home", "config"),
  XDG_DATA_HOME: path.join(fixture, "home", "data"),
  XDG_CACHE_HOME: path.join(fixture, "home", "cache"),
  TMPDIR: path.join(fixture, "tmp"),
  TMP: path.join(fixture, "tmp"),
  TEMP: path.join(fixture, "tmp"),
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
  OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "reported-checks",
});

if (mode === "run" && !values.execute) {
  assert.ok(values.output, "--output is required and must be fresh");
  assert.ok(fs.existsSync(manifestPath), "--fixture must contain a generated fixture.json");
  const output = path.resolve(values.output);
  fs.mkdirSync(output, { recursive: false });
  fs.mkdirSync(path.join(output, "profiles"));
  fs.writeFileSync(path.join(output, "phase"), "parent-startup");
  const observer = values["observer-root"]
    ? path.join(path.resolve(values["observer-root"]), "observer.cjs")
    : undefined;
  assert.ok(observer || values.profile, "Supply --observer-root for counts and/or --profile");
  if (observer) {
    assert.ok(fs.existsSync(observer), "Frozen observer.cjs is missing");
  }
  const probe = path.join(output, "probe.cjs");
  fs.writeFileSync(probe, createDoctorConfigProbe({ output, observer, profile: values.profile }));
  const args = [
    ...(values.profile
      ? [
          "--cpu-prof",
          "--cpu-prof-interval=10000",
          `--cpu-prof-dir=${path.join(output, "profiles")}`,
        ]
      : []),
    "--require",
    probe,
    "--import",
    path.join(root, "scripts", "tsx.mjs"),
    fileURLToPath(import.meta.url),
    "run",
    "--repo",
    root,
    "--fixture",
    fixture,
    "--output",
    output,
    "--execute",
  ];
  const stdout = fs.openSync(path.join(output, "stdout.log"), "w");
  const stderr = fs.openSync(path.join(output, "stderr.log"), "w");
  fs.writeFileSync(
    path.join(output, "command.json"),
    JSON.stringify([process.execPath, ...args], null, 2),
  );
  try {
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...isolatedEnv, SQLMEASURE_OUT: output },
      stdio: ["ignore", stdout, stderr],
    });
    fs.writeFileSync(
      path.join(output, "exit.json"),
      JSON.stringify(
        {
          exitCode: child.status,
          signal: child.signal,
          error: child.error?.message,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ output, exitCode: child.status, signal: child.signal }));
    process.exitCode = child.status ?? 1;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
} else {
  // No source module sees inherited live configuration or credentials.
  const nodeOptions = values.execute ? process.env.NODE_OPTIONS : undefined;
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, isolatedEnv);
  if (nodeOptions) {
    process.env.NODE_OPTIONS = nodeOptions;
  }
  if (values.output) {
    process.env.SQLMEASURE_OUT = path.resolve(values.output);
  }
  const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
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
  const { closeOpenClawStateDatabaseAsync }: typeof import("../../src/state/openclaw-state-db.js") =
    await load("src/state/openclaw-state-db.ts");
  try {
    if (mode === "fixture") {
      await createFixture();
    } else {
      await runDoctor();
    }
  } finally {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const {
      closeDefaultRetainedNativeWorkerSource,
    }: typeof import("../../src/infra/worker-native-lifecycle.js") = await load(
      "src/infra/worker-native-lifecycle.ts",
    );
    const { closePostgresPool }: typeof import("../../src/infra/postgres-sync/pool.js") =
      await load("src/infra/postgres-sync/pool.ts");
    await closeDefaultRetainedNativeWorkerSource();
    await closePostgresPool();
  }

  async function createFixture() {
    const target = Number(values.bytes);
    assert.ok(Number.isSafeInteger(target) && target > 0, "--bytes must be a positive integer");
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 45771,
        auth: { mode: "token", token: "qa-doctorconfig-synthetic" },
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
            { workspace: path.join(fixture, "workspace", agentId) },
          ]),
        ),
      },
      logging: { file: path.join(fixture, "gateway.log") },
    };
    for (const agentId of agents) {
      fs.mkdirSync(path.join(fixture, "workspace", agentId), { recursive: true });
    }
    const { validateConfigObjectRaw }: typeof import("../../src/config/validation-core.js") =
      await load("src/config/validation-core.ts");
    assert.ok(validateConfigObjectRaw(config).ok, "Synthetic configuration must validate");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const {
      writeSessionEntry,
    }: typeof import("../../src/config/sessions/session-accessor.sqlite-entry-store.js") =
      await load("src/config/sessions/session-accessor.sqlite-entry-store.ts");
    const {
      appendTranscriptEventsInTransaction,
    }: typeof import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js") =
      await load("src/config/sessions/session-accessor.sqlite-transcript-store.ts");
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const databases = agents.map((agentId) => openOpenClawAgentDatabase({ agentId }));
    for (const agentId of agents) {
      for (let offset = 0; offset < sessionsPerAgent; offset += 128) {
        runOpenClawAgentWriteTransaction(
          (database) => {
            for (let i = offset; i < offset + 128; i++) {
              const sessionId = `synthetic-${agentId}-${i}`;
              const sessionKey = `agent:${agentId}:doctorconfig-${i}`;
              writeSessionEntry(database, sessionKey, {
                sessionId,
                updatedAt: now,
                createdAt: now,
                sessionStartedAt: now,
                lastInteractionAt: now,
                lastActivityAt: now,
                lifecycleRevision: "synthetic-v1",
                label: "Synthetic update size fixture",
                status: "done",
                createdVia: "operator",
              });
              appendTranscriptEventsInTransaction(database, { agentId, sessionKey, sessionId }, [
                { type: "session", version: 3, id: sessionId, timestamp },
              ]);
            }
          },
          { agentId },
        );
      }
    }
    const key = createHash("sha256").update("doctorconfig-size-fixture-v1").digest();
    const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
    const started = performance.now();
    let messages = 0;
    function checkpointBytes() {
      return databases.reduce((total, database) => {
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        return total + fs.statSync(database.path).size;
      }, 0);
    }
    let actualDatabaseBytes = checkpointBytes();
    while (actualDatabaseBytes < target) {
      for (let count = 0; count < 128; count++) {
        const agentId = agents[messages % agents.length];
        assert.ok(agentId);
        const i = Math.floor(messages / agents.length) % sessionsPerAgent;
        const text = cipher.update(Buffer.alloc(192 * 1024)).toString("base64");
        runOpenClawAgentWriteTransaction(
          (database) =>
            appendTranscriptEventsInTransaction(
              database,
              {
                agentId,
                sessionId: `synthetic-${agentId}-${i}`,
                sessionKey: `agent:${agentId}:doctorconfig-${i}`,
              },
              [
                {
                  type: "message",
                  id: `size-${messages}`,
                  parentId: null,
                  timestamp,
                  message: { role: "user", content: [{ type: "text", text }], timestamp: now },
                },
              ],
            ),
          { agentId },
        );
        messages++;
      }
      actualDatabaseBytes = checkpointBytes();
      console.log(JSON.stringify({ messages, actualDatabaseBytes, targetBytes: target }));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kind: "openclaw-doctor-config-synthetic-v1",
          agentCount: agents.length,
          sessionCount: agents.length * sessionsPerAgent,
          messages,
          actualDatabaseBytes,
          targetBytes: target,
          generationMs: performance.now() - started,
          databases: databases.map((database) => ({
            agentId: database.agentId,
            path: path.relative(fixture, database.path),
            bytes: fs.statSync(database.path).size,
          })),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ completed: true, actualDatabaseBytes, messages }));
  }

  async function runDoctor() {
    assert.ok(values.output);
    const output = path.resolve(values.output);
    const phase = (name: string) => {
      fs.writeFileSync(path.join(output, "phase"), name);
      fs.appendFileSync(
        path.join(output, "phases.jsonl"),
        `${JSON.stringify({ name, time: Date.now() })}\n`,
      );
    };
    phase("parent-startup");
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
    const { readUpdateRunDriver }: typeof import("../../src/infra/update-run-driver.js") =
      await load("src/infra/update-run-driver.ts");
    const {
      createUpdateDatabaseBackup,
    }: typeof import("../../src/infra/update-database-backup.js") = await load(
      "src/infra/update-database-backup.ts",
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
    const {
      readPackageUpdateIdentity,
    }: typeof import("../../src/cli/update-cli/update-command-package-identity.js") = await load(
      "src/cli/update-cli/update-command-package-identity.ts",
    );
    const runId = randomUUID();
    const steps: UpdateStepResult[] = [];
    const result: Record<string, unknown> = {
      runId,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      load: os.loadavg(),
      fixture: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      steps,
    };
    try {
      await withUpdateCommandExecutor(runId, async (executor) => {
        const executorFence = await executor.enter(root);
        createUpdateRun({ runId, trigger: "cli", origin: { admission: { owner: "installed" } } });
        const adopted = adoptUpdateRun(runId);
        assert.ok(adopted.origin.driver, "Native driver adoption must succeed");
        phase("original-capture");
        const captureStarted = performance.now();
        const captureCpu = process.cpuUsage();
        await closeOpenClawStateDatabaseAsync();
        const driver = readUpdateRunDriver();
        assert.ok(driver);
        const captured = await captureUpdateRecoveryBaseline({
          runId,
          installRoot: root,
          env: process.env,
          drivers: [driver],
          assertCurrent: () => executorFence.assertCurrent(),
          nodeRunner: process.execPath,
          timeoutMs: 30 * 60_000,
        });
        result.originalCapture = {
          warnings: captured.warnings.length,
          durationMs: performance.now() - captureStarted,
          parentCpuMicros: process.cpuUsage(captureCpu),
        };
        phase("database-backup");
        const config: OpenClawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const databaseBackup = await createUpdateDatabaseBackup({
          backupRoot: path.join(fixture, "retained-package"),
          stateDir: state,
          config,
          env: process.env,
          stopped: true,
          nodeRunner: process.execPath,
          timeoutMs: 30 * 60_000,
        });
        assert.deepEqual(
          databaseBackup.warnings,
          [],
          "Stopped backup must succeed without warnings",
        );
        result.backup = {
          databases: databaseBackup.databases.length,
          generations: Object.keys(databaseBackup.sourceGenerations).length,
        };
        const run = {
          runId,
          databaseBackup,
          env: { ...process.env },
          executorFence,
          originalRecoveryCapture: captured.ref,
        };
        const guards = createUpdateCommandExecutionGuards(
          { yes: true, json: true, restart: true, run },
          root,
        );
        phase("doctor");
        const snapshot = await readUpdateConfigSnapshot(configPath);
        const started = performance.now();
        const cpu = process.cpuUsage();
        const doctor = await runPackageUpdateDoctor({
          root,
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
            originalRecoveryCapture: captured.ref,
            databaseBackup,
            ...guards,
          }),
        });
        result.doctorMs = performance.now() - started;
        result.doctorParentCpuMicros = process.cpuUsage(cpu);
        result.doctor = doctor;
        assert.ok(
          doctor && (doctor.exitCode === 0 || doctor.exitCode === 86),
          "Compiled Doctor must complete",
        );
        assert.ok(
          !doctor.configWriteRefusal && !doctor.failureFacts?.length,
          "Doctor must settle without refusal",
        );
        phase("verification");
        const ledger = getUpdateRun(runId);
        assert.ok(
          ledger &&
            ledger.steps.some(
              (step) =>
                step.step === "finalize:doctor:model-retirement" && step.status === "skipped",
            ),
          "Doctor must record a genuine deferred retirement receipt",
        );
        result.ledgerSteps = ledger.steps;
        const identity = await readPackageUpdateIdentity(root);
        assert.ok(
          identity.version && identity.buildId,
          "The target must have a compiled runtime identity",
        );
        result.targetIdentity = identity;
        finishUpdateRun(runId, { status: "succeeded" });
      });
      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.error = String(error);
      process.exitCode = 1;
    } finally {
      phase("cleanup");
      fs.writeFileSync(path.join(output, "direct-result.json"), JSON.stringify(result, null, 2));
    }
  }
}
