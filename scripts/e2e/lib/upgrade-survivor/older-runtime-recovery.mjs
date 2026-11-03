import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  openInstalledRecoveryEvidence,
  writeInstalledRecoveryEvidence,
} from "./installed-recovery-observations.mjs";
import { readDatabase } from "./observations.mjs";
import {
  readWorkerCellPackageIdentity,
  assertWorkerCellPackageIdentity,
  resolveWorkerCellExport,
} from "./worker-cell-package.mjs";

let phase = "resolve-installed-root";
const sourceFiles = new Set(["older-runtime-recovery.mjs", "daemon-cli.js"]);
async function main() {
  const [artifacts, candidateRoot, rootArgument, tarball, publishedOperation, inputPath] =
    process.argv.slice(2);
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
      sourceFiles.add(name);
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
  const userData = { cursor: 137, label: "archive — 東京", enabled: false };
  if (publishedOperation) {
    phase = "published-runtime";
    let value;
    if (publishedOperation === "notice") {
      const writer = await binding(root, "restart-sentinel", "writeRestartSentinel");
      value = await writer.call(read(inputPath).notice, process.env);
    } else {
      const oldDaemon = await import(pathToFileURL(path.join(root, "dist/cli/daemon-cli.js")).href);
      assert.equal(
        oldDaemon.runManagedHandoffSentinelChild,
        undefined,
        "published runtime must lack the new operation export",
      );
      const store = await import(
        pathToFileURL(path.join(root, "dist/plugin-sdk/plugin-state-store-runtime.js")).href
      );
      const kv = store.createPluginStateSyncKeyedStore("older-runtime-survivor", {
        namespace: "preferences",
        maxEntries: 1,
        env: process.env,
      });
      if (publishedOperation === "seed") {
        // The published SDK and ledger own the real synchronous database commits.
        kv.register("authored", userData);
        const ledger = await binding(root, "update-run-ledger", "createUpdateRun");
        value = ledger.call({
          trigger: "cli",
          before: { version: read(path.join(root, "package.json")).version },
          target: { tag: tarball },
        });
      } else {
        assert.equal(publishedOperation, "verify");
        value = { stored: kv.lookup("authored"), settled: oldDaemon.getUpdateRun(inputPath) };
      }
    }
    fs.writeSync(1, JSON.stringify(value));
    // Owner calls have committed before this synchronous result. Their idle
    // worker handles must not keep the disposable published probe alive.
    process.exit(0);
  }
  phase = "read-package-identities";
  const baseline = readWorkerCellPackageIdentity(root);
  const candidate = readWorkerCellPackageIdentity(candidateRoot);
  assert.equal(baseline.version, "2026.10.9");
  assert.notEqual(baseline.buildInfo.buildId, candidate.buildInfo.buildId);
  // Different releases share process-global worker registries. Keep published
  // imports in their own process instead of contaminating the candidate host.
  const published = (operation, input = "") =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), artifacts, candidateRoot, root, tarball, operation, input],
        {
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
        },
      ),
    );
  phase = "seed-published-runtime";
  const run = published("seed");
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
  const runtimeFile = `${process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG}.runtime.json`;
  phase = "read-serving-gateway";
  const parentPid = read(runtimeFile).pid;
  assert(Number.isSafeInteger(parentPid) && parentPid > 1);
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
  const preservedNotice = path.join(artifacts, "refused-notice.json");
  write(specPath, {
    root,
    candidateRoot,
    tarball,
    runId: run.runId,
    handoffId,
    notice,
    noticeReceipt,
    preservedNotice,
  });
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
    read(preservedNotice),
    concurrent.row,
    "canonical handoff must preserve the unrelated notice when refusing its outcome write",
  );
  assert.deepEqual(JSON.parse(concurrent.row.payload_json), notice);
  phase = "verify-operator-state";
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), baseline);
  assert.deepEqual(settings(), beforeSettings);
  assert.equal(hash(dataFile), dataDigest);
  const { stored, settled } = published("verify", run.runId);
  assert.deepEqual(stored, userData);
  phase = "verify-terminal-ledger";
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
    let captured = false;
    try {
      const fd = openInstalledRecoveryEvidence(path.join(process.argv[2], "driver.err"));
      try {
        fs.writeFileSync(
          fd,
          String(error instanceof Error ? (error.stack ?? error.message) : error),
        );
        captured = true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Evidence failure must not expose the exception it was meant to keep private.
    }
    // Only installed public module names and numeric coordinates leave private evidence.
    // Prefer causes so wrapper frames cannot crowd the failing owner out of the cap.
    const sites = [];
    for (
      let cause = error, depth = 0;
      cause instanceof Error && depth < 4;
      cause = cause.cause, depth++
    ) {
      const causeSites = [];
      for (const line of cause.stack?.split("\n", 16).slice(1) ?? []) {
        const frame = line.startsWith("    at ")
          ? line.match(/\/([^/]+\.m?js):(\d{1,8}):(\d{1,8})\)?$/u)
          : null;
        if (frame && sourceFiles.has(frame[1])) {
          causeSites.push(frame.slice(1).join(":"));
        }
      }
      sites.unshift(...causeSites);
    }
    fs.writeSync(
      2,
      `[older-runtime-recovery] phase=${phase} sites=${[...new Set(sites)].slice(0, 8).join(",") || "unknown"}\n`,
    );
    fs.writeSync(
      2,
      captured
        ? "[older-runtime-recovery] inspect driver.err in the private run evidence\n"
        : "[older-runtime-recovery] private driver diagnostic unavailable\n",
    );
    fs.writeSync(2, "[older-runtime-recovery] FAILED (exit 1)\n");
    // The disposable container owns remaining fixture children. Let its EXIT
    // capture run now, before their live handles consume the whole-cell deadline.
    process.exit(1);
  },
);
