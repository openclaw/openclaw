// Synthetic fresh-install capture → Doctor → rollback. Never reads operator state.
// node --import ./scripts/tsx.mjs scripts/perf/sqlite-staging-maintenance-measure.mts \
//   --base <checkout> --candidate <checkout> --out <new directory> [--pairs 5]
// Parent CPU/allocation are phase-scoped; OS time includes descendant CPU for the full sample.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { MutableUpdateExecutionParams } from "../../src/cli/update-cli/update-command-execution.types.js";
import type { UpdateRunResult } from "../../src/infra/update-runner-types.js";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    out: { type: "string" },
    pairs: { type: "string", default: "5" },
    subject: { type: "string" },
    sample: { type: "string" },
  },
});
assert(values.out, "--out is required");
const out = path.resolve(values.out);
fs.mkdirSync(out, { mode: 0o700 });
if (!values.subject) {
  assert(values.base && values.candidate, "--base and --candidate are required");
  const pairs = Number(values.pairs);
  assert(Number.isInteger(pairs) && pairs >= 1);
  const records = [];
  const variants = [
    ["aa1", values.base],
    ["aa2", values.base],
    ...Array.from({ length: pairs }, (_, i) => [
      [`a${i + 1}`, values.base],
      [`b${i + 1}`, values.candidate],
    ]).flat(),
  ];
  for (const [label, checkout] of variants) {
    const subject = fs.realpathSync(checkout!);
    const args = [
      process.execPath,
      "--import",
      path.join(subject, "scripts/tsx.mjs"),
      fileURLToPath(import.meta.url),
      "--subject",
      subject,
      "--sample",
      label!,
      "--out",
      path.join(out, label!),
    ];
    const timed = process.platform === "darwin" || process.platform === "linux";
    const result = spawnSync(
      timed ? "/usr/bin/time" : process.execPath,
      timed ? [process.platform === "darwin" ? "-l" : "-v", ...args] : args.slice(1),
      { cwd: subject, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(out, `${label}.log`), result.stdout + result.stderr);
    assert.equal(result.status, 0, `${label}: ${result.error ?? result.stderr.slice(-4000)}`);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("STAGING_METRIC "));
    assert(line, `${label} returned no measurement`);
    const mac = result.stderr.match(/([\d.]+) user\s+([\d.]+) sys(?:tem)?/u);
    const linuxUser = result.stderr.match(/User time \(seconds\): ([\d.]+)/u);
    const linuxSystem = result.stderr.match(/System time \(seconds\): ([\d.]+)/u);
    const totalCpuMs = mac
      ? (Number(mac[1]) + Number(mac[2])) * 1000
      : linuxUser && linuxSystem
        ? (Number(linuxUser[1]) + Number(linuxSystem[1])) * 1000
        : undefined;
    records.push({ ...JSON.parse(line.slice("STAGING_METRIC ".length)), totalCpuMs });
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ records }, null, 2) + "\n");
    console.log(JSON.stringify(records.at(-1)));
  }
} else {
  const subject = fs.realpathSync(values.subject);
  const stateDir = path.join(out, "state");
  fs.mkdirSync(stateDir);
  const env = {
    ...process.env,
    HOME: out,
    USERPROFILE: out,
    OPENCLAW_HOME: out,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    XDG_CACHE_HOME: path.join(out, "cache"),
    TMPDIR: path.join(out, "tmp"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  fs.mkdirSync(env.TMPDIR);
  Object.assign(process.env, env);
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
  const module = (file: string) => pathToFileURL(path.join(subject, "src", file)).href;
  const { captureUpdateDatabases, restoreFailedUpdateDatabases } = await import(
    module("cli/update-cli/update-command-database-backup.ts")
  );
  const { recordUpdateDatabaseWrites } = await import(
    module("cli/update-cli/update-command-database-receipts.ts")
  );
  const { beginDoctorMaintenance } = await import(module("commands/doctor-maintenance.ts"));
  const { closeOpenClawStateDatabaseAsync, prepareOpenClawStateDatabaseSchema } = await import(
    module("state/openclaw-state-db.ts")
  );
  const { createUpdateRun, getUpdateRun } = await import(module("infra/update-run-ledger.ts"));
  const { openNodeSqliteDatabase } = await import(module("infra/node-sqlite.ts"));
  const { OPENCLAW_STATE_SCHEMA_VERSION } = await import(
    module("state/openclaw-state-db-contract.ts")
  );
  const { runClientCredentialOperation } = await import(module("infra/client-credential-store.ts"));
  const run = createUpdateRun({ trigger: "cli" }, { env });
  assert.equal(run.phase, "requested");
  await closeOpenClawStateDatabaseAsync();
  const unexpected = () => {
    throw new Error("Unrelated update orchestration");
  };
  const execution: MutableUpdateExecutionParams = {
    root: out,
    installKind: "package",
    updateInstallKind: "package",
    packageInstallTarget: {
      manager: "npm",
      command: "npm",
      globalRoot: out,
      packageRoot: out,
      npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
    },
    switchToGit: false,
    timeoutMs: undefined,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    executionGuards: {
      recordPhase: unexpected,
      recordStep: unexpected,
      captureWriteOptions: unexpected,
      onStateHandoff: unexpected,
      admitExecutor: unexpected,
      assertCurrent() {},
      waitForCurrent: unexpected,
      assertBoundChildCurrent() {},
    },
    stop: unexpected,
    channel: "stable",
    tag: "fixture",
    opts: { run: { runId: run.runId, env } },
    shouldRestart: false,
    packageInstallSpec: null,
    packageUpdateNodeRunner: process.execPath,
    managedServiceRootRedirect: null,
    recoveryState: { triageTarget: { env } },
    prepareMutableUpdate: unexpected,
  };
  const captured = await captureUpdateDatabases({
    transaction: {
      backupRoot: path.join(out, run.runId),
      rollback: unexpected,
      complete: unexpected,
    },
    execution,
    context: undefined,
    assertCurrent() {},
  });
  assert(captured.backup, captured.step.warnings?.join("\n"));
  assert.deepEqual(captured.backup.warnings, []);
  const phases: object[] = [];
  async function measure(phase: string, action: () => Promise<void>) {
    const profiler = new Session();
    profiler.connect();
    await new Promise<void>((resolve, reject) => {
      profiler.post(
        "HeapProfiler.startSampling",
        {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const cpu = process.cpuUsage(),
      at = performance.now();
    try {
      await action();
    } finally {
      const ms = performance.now() - at,
        used = process.cpuUsage(cpu);
      const sampledV8Bytes = await new Promise<number>((resolve, reject) => {
        profiler.post("HeapProfiler.stopSampling", (error, result) =>
          error
            ? reject(error)
            : resolve(result.profile.samples.reduce((sum, entry) => sum + entry.size, 0)),
        );
      });
      profiler.disconnect();
      phases.push({ phase, ms, hostCpuMs: (used.user + used.system) / 1000, sampledV8Bytes });
    }
  }
  try {
    await measure("fresh-maintenance", async () => {
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations: captured.backup.sourceGenerations,
      });
      assert(maintenance);
      try {
        const outcome = await maintenance.run(() =>
          prepareOpenClawStateDatabaseSchema({ env }, "doctor"),
        );
        assert.deepEqual(outcome.warnings, []);
        await maintenance.releaseState();
        assert.equal(maintenance.databaseWrites?.unchanged, true);
        assert(
          recordUpdateDatabaseWrites(captured.backup, maintenance.databaseWrites, {
            name: "candidate Doctor",
          }),
        );
        assert.equal(captured.backup.restoreRefusal, undefined);
      } finally {
        await maintenance.release();
        await closeOpenClawStateDatabaseAsync();
      }
    });
    const identity = () =>
      runClientCredentialOperation(
        env,
        { kind: "identity.read", identity_key: "primary" },
        { readOnly: true },
      );
    assert.deepEqual(identity(), { kind: "identity", identity: null });
    await measure("fresh-rollback", async () => {
      const result: UpdateRunResult = {
        status: "error",
        mode: "npm",
        durationMs: 0,
        reason: "synthetic-candidate-failure",
        steps: [],
      };
      assert.equal(
        await restoreFailedUpdateDatabases({
          backup: captured.backup,
          runId: run.runId,
          env,
          assertCurrent() {},
          result,
          progress: {},
        }),
        true,
        JSON.stringify(result),
      );
      using db = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      assert.equal(
        db.prepare("PRAGMA user_version").get()?.user_version,
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      assert.deepEqual(getUpdateRun(run.runId, { env }), run);
    });
    assert.deepEqual(identity(), { kind: "identity", identity: null });
    console.log(
      "STAGING_METRIC " +
        JSON.stringify({
          label: values.sample,
          subject,
          node: process.version,
          phases,
          hostLoad: loadavg(),
        }),
    );
  } finally {
    await closeOpenClawStateDatabaseAsync();
    const { cleanupSnapshotOperations } = await import(
      module("infra/sqlite-readonly-location-cleanup.ts")
    );
    await cleanupSnapshotOperations();
  }
}
