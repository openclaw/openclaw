import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeInstalledRecoveryEvidence } from "./installed-recovery-observations.mjs";
import { readDatabase } from "./observations.mjs";
import {
  readWorkerCellPackageIdentity,
  assertWorkerCellPackageIdentity,
  resolveWorkerCellExport,
} from "./worker-cell-package.mjs";

let phase = "resolve-installed-root";
async function main() {
  const [artifacts, candidateRoot, rootArgument, tarball] = process.argv.slice(2);
  const root = fs.realpathSync(rootArgument);
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (file, value) =>
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 900_000;
    while (!(await predicate())) {
      assert(Date.now() < deadline, `Timed out waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  };
  async function binding(packageRoot, prefix, symbol) {
    const matches = [];
    const owners = [];
    for (const name of fs.readdirSync(path.join(packageRoot, "dist")).toSorted()) {
      if (!name.startsWith(`${prefix}-`) || !name.endsWith(".mjs")) {
        continue;
      }
      const file = path.join(packageRoot, "dist", name);
      const alias = resolveWorkerCellExport(fs.readFileSync(file, "utf8"), symbol);
      if (!alias) {
        continue;
      }
      matches.push((await import(pathToFileURL(file).href))[alias]);
      owners.push({ name, sha256: hash(file) });
    }
    const functions = [...new Set(matches)];
    assert.equal(functions.length, 1, `One packaged ${symbol} owner is required`);
    assert.equal(typeof functions[0], "function");
    return { call: functions[0], owners };
  }
  phase = "read-package-identities";
  const baseline = readWorkerCellPackageIdentity(root);
  const candidate = readWorkerCellPackageIdentity(candidateRoot);
  assert.equal(baseline.version, "2026.10.9");
  assert.notEqual(baseline.buildInfo.buildId, candidate.buildInfo.buildId);
  phase = "load-published-runtime";
  const oldDaemon = await import(pathToFileURL(path.join(root, "dist/cli/daemon-cli.js")).href);
  assert.equal(
    oldDaemon.runManagedHandoffSentinelChild,
    undefined,
    "published runtime must lack the new operation export",
  );
  phase = "load-published-ledger-owner";
  const ledger = await binding(root, "update-run-ledger", "createUpdateRun");
  phase = "load-candidate-handoff-owner";
  const start = await binding(
    candidateRoot,
    "update-managed-service-handoff",
    "startManagedServiceUpdateHandoff",
  );
  phase = "load-candidate-transfer-owner";
  const transfer = await binding(
    candidateRoot,
    "update-managed-service-handoff",
    "transferManagedServiceUpdateHandoff",
  );
  phase = "seed-operator-state";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const settings = () => {
    const config = read(configPath);
    return { gateway: config.gateway, plugins: config.plugins };
  };
  const beforeSettings = settings();
  const workspace = process.env.OPENCLAW_TEST_WORKSPACE_DIR;
  assert(workspace, "isolated workspace is required");
  fs.mkdirSync(workspace, { recursive: true });
  const dataFile = path.join(workspace, "MEMORY.md");
  fs.writeFileSync(dataFile, "# Existing memory\n\nPreserve the operator's archive — 東京.\n");
  const dataDigest = hash(dataFile);
  // Use the published SDK's real persistent store, not fixture SQL inserts.
  const store = await import(
    pathToFileURL(path.join(root, "dist/plugin-sdk/plugin-state-store-runtime.js")).href
  );
  const kv = store.createPluginStateSyncKeyedStore("older-runtime-survivor", {
    namespace: "preferences",
    env: process.env,
  });
  const userData = { cursor: 137, label: "archive — 東京", enabled: false };
  kv.register("authored", userData);
  const runtimeFile = `${process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG}.runtime.json`;
  phase = "read-serving-gateway";
  const parentPid = read(runtimeFile).pid;
  assert(Number.isSafeInteger(parentPid) && parentPid > 1);
  const run = ledger.call({
    trigger: "cli",
    before: { version: baseline.version },
    target: { tag: tarball },
  });
  const handoffId = randomUUID();
  const notice = {
    kind: "update",
    status: "error",
    ts: Date.now(),
    stats: {
      runId: `unrelated-${randomUUID()}`,
      handoffId,
      root,
      reason: "unrelated-update-failure",
      steps: [],
    },
  };
  const specPath = path.join(artifacts, "older-runtime-observer.json");
  const noticeReceipt = path.join(artifacts, "concurrent-notice.json");
  const recoveryNotice = path.join(artifacts, "pre-recovery-notice.json");
  write(specPath, { root, runId: run.runId, handoffId, notice, noticeReceipt, recoveryNotice });
  const anchor = path.join(
    path.dirname(root),
    `.openclaw.package-activation-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
  );
  const faultPath = path.join(artifacts, "package-activation-fault.json");
  const faultEvidence = path.join(artifacts, "package-activation-cut.json");
  write(faultPath, {
    journal: `${anchor}.control/operation.sqlite`,
    evidence: faultEvidence,
    previousRoot: path.join(anchor, "previous"),
    cut: "verification-rollback",
  });
  const observer = new URL("./older-runtime-recovery-observer.mjs", import.meta.url).pathname;
  const fault = new URL("./package-activation-fault.mjs", import.meta.url).pathname;
  const env = {
    ...process.env,
    OPENCLAW_SURVIVOR_OLDER_RUNTIME: specPath,
    OPENCLAW_SURVIVOR_PACKAGE_FAULT: faultPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${observer} --import=${fault}`.trim(),
  };
  phase = "start-candidate-handoff";
  const result = await start.call({
    root,
    runId: run.runId,
    handoffId,
    parentPid,
    supervisor: "systemd",
    execPath: process.execPath,
    argv1: path.join(root, "openclaw.mjs"),
    env,
    tag: tarball,
    timeoutMs: 900_000,
    restartDrainTimeoutMs: 300_000,
    meta: { note: "Packaged rollback recovery probe" },
  });
  phase = "inspect-captured-helper";
  assert.equal(result.status, "started");
  const directory = path.dirname(result.logPath);
  const params = read(path.join(directory, "handoff.json"));
  assert.equal(params.recoveryModulePath, path.join(root, "dist/cli/daemon-cli.js"));
  assert.equal(params.parentPid, parentPid);
  const stagedRuntime = path.join(directory, "runtime/managed-handoff-runtime.mjs");
  assert.equal(
    hash(stagedRuntime),
    hash(path.join(candidateRoot, "dist/managed-handoff-runtime.mjs")),
  );
  const generated = params.sensitivePaths
    .filter((file) => fs.existsSync(file))
    .map((file) => ({
      name: path.relative(directory, file),
      sha256: hash(file),
    }));
  phase = "transfer-captured-helper";
  assert(await transfer.call({ kind: "managed-update-handoff", handoffId, installRoot: root }));
  phase = "wait-rollback-settlement";
  await wait(
    () => fs.readFileSync(result.logPath, "utf8").includes("managed update helper completed code="),
    "managed rollback settlement",
  );
  const log = fs.readFileSync(result.logPath, "utf8");
  await wait(() => {
    try {
      return fs
        .readFileSync(`/proc/${result.pid}/stat`, "utf8")
        .split(") ")
        .at(-1)
        .startsWith("Z ");
    } catch (error) {
      if (error.code === "ENOENT") {
        return true;
      }
      throw error;
    }
  }, "helper process exit");
  phase = "verify-rollback-outcome";
  assert.match(log, /managed update helper completed code=1/u);
  assert.match(log, /Update notice changed or belongs to another handoff; it was not replaced\./u);
  assert.doesNotMatch(
    log,
    /could not be recorded|failed to finalize update run|Gateway recovery failed/u,
  );
  assert.equal(read(`${faultEvidence}.doctor`).exitCode, 1);
  assert.equal(read(faultEvidence).row.phase, "publication-complete");
  assert.equal(
    read(`${faultEvidence}.doctor`).manifestDigest,
    baseline.files["package.json"].sha256,
  );
  const concurrent = read(noticeReceipt);
  assert.equal(concurrent.observerError, undefined);
  assert.equal(concurrent.signal, null);
  assert.notEqual(concurrent.code, 0);
  assert.equal(concurrent.result.runId, run.runId);
  assert.equal(concurrent.result.recovery.packageRollbackVerified, true);
  assert.equal(concurrent.result.recovery.serviceRestartSafe, true);
  assert.equal(concurrent.result.after.version, baseline.version);
  assert.deepEqual(
    read(recoveryNotice),
    concurrent.row,
    "canonical handoff must preserve the unrelated notice before Gateway recovery",
  );
  assert.deepEqual(JSON.parse(concurrent.row.payload_json), notice);
  phase = "verify-operator-state";
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), baseline);
  assert.deepEqual(settings(), beforeSettings);
  assert.equal(hash(dataFile), dataDigest);
  assert.deepEqual(kv.lookup("authored"), userData);
  phase = "verify-terminal-ledger";
  const settled = oldDaemon.getUpdateRun(run.runId);
  assert.equal(settled.status, "rolled-back");
  assert(
    settled.steps.some(
      (step) => step.step === "previous generation restoration" && step.status === "completed",
    ),
  );
  phase = "verify-helper-cleanup";
  assert.equal(
    readDatabase(
      params.updateLeaseDatabasePath,
      (db) =>
        db
          .prepare("SELECT count(*) AS n FROM managed_update_handoffs WHERE install_root = ?")
          .get(root).n,
    ),
    0,
  );
  for (const file of params.sensitivePaths) {
    assert(!fs.existsSync(file), `Sensitive helper file remains: ${path.basename(file)}`);
  }
  phase = "verify-restored-gateway";
  const replacement = read(runtimeFile);
  assert.notEqual(replacement.pid, parentPid);
  process.kill(replacement.pid, 0);
  const ready = await fetch("http://127.0.0.1:18789/readyz");
  assert.equal(ready.status, 200);
  const cmdline = fs.readFileSync(`/proc/${replacement.pid}/cmdline`, "utf8").split("\0");
  assert(
    cmdline.some((arg) => arg.startsWith(root + "/")),
    "fresh Gateway must execute the restored published package",
  );
  write(path.join(artifacts, "older-runtime-recovery.json"), {
    status: "passed",
    baseline: { version: baseline.version, build: baseline.buildInfo },
    candidate: { build: candidate.buildInfo, tarballSha256: hash(tarball), owners: start.owners },
    generated,
    runId: run.runId,
    update: { exitCode: concurrent.code, recovery: concurrent.result.recovery },
    terminalStatus: settled.status,
    originalGatewayPid: parentPid,
    recoveredGatewayPid: replacement.pid,
    settingsPreserved: true,
    dataPreserved: true,
    unrelatedNoticePreservedBeforeRecovery: true,
    oldOperationExportAbsent: true,
    leaseReleased: true,
    sensitiveFilesRemoved: true,
    readyStatus: ready.status,
  });
  writeInstalledRecoveryEvidence(path.join(path.dirname(artifacts), "installed-recovery.json"), {
    status: "passed",
    runDirectory: path.basename(artifacts),
    selectedCuts: ["older-runtime"],
  });
}
await main().catch(
  /** @param {unknown} error */ (error) => {
    fs.writeFileSync(
      path.join(process.argv[2], "driver.err"),
      String(error instanceof Error ? (error.stack ?? error.message) : error),
      {
        mode: 0o600,
      },
    );
    // Assertion values stay private; publish only our static step and numeric source location.
    const frame =
      error instanceof Error
        ? error.stack?.split("\n").find((line) => line.includes(import.meta.url))
        : undefined;
    const site =
      frame
        ?.slice(frame.indexOf(import.meta.url) + import.meta.url.length)
        .match(/^:(\d+):(\d+)/u)
        ?.slice(1)
        .join(":") ?? "unknown";
    console.error(`[older-runtime-recovery] phase=${phase} site=${site}`);
    console.error("[older-runtime-recovery] inspect driver.err in the private run evidence");
    console.error("[older-runtime-recovery] FAILED (exit 1)");
    process.exitCode = 1;
  },
);
