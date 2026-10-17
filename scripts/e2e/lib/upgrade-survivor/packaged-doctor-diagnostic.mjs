// Opt-in packaged Doctor diagnostic; never invokes update or changes package bytes.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toErrorObject } from "../../../lib/error-format.mts";
import { hasUnjoinedWork, runManagedCommand } from "../../../lib/managed-child-process.mts";
import {
  snapshotEvidenceRecords,
  summarizeSnapshotCleanupEvidence,
} from "./snapshot-cleanup-evidence.mjs";
import {
  seedSnapshotCleanupRefusal,
  writeSnapshotCleanupEvidence,
  assertSnapshotDoctorCaptureRefusal,
} from "./snapshot-cleanup-refusal.mjs";
import {
  readWorkerCellPackageIdentity,
  assertWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const [candidateArg, artifactsArg] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert(fs.existsSync("/.dockerenv"), "Use the existing disposable Docker E2E owner");
assert.equal(os.userInfo().homedir, "/home/appuser");
assert(candidateArg && artifactsArg);
const candidateTar = fs.realpathSync(candidateArg);
const artifacts = fs.realpathSync(artifactsArg);
const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
assert(root && !fs.existsSync(root), "Diagnostic runtime must be fresh and caller-owned");
fs.mkdirSync(root, { mode: 0o700 });
const hash = (v) => createHash("sha256").update(v).digest("hex");
const write = (name, value) =>
  fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value, null, 2), { mode: 0o600 });
// This diagnostic consumes the historical failed package, never a relabeled candidate.
const expectedSha = "100eaf0185f45779dd5ee7809f894f9867917eb19233e5c6ea86ecfbe9346281";
assert.equal(hash(fs.readFileSync(candidateTar)), expectedSha);
assert.equal(
  process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
  "dd3cc2e60e3fe8382d65f4221362ba51bebfa610",
);
const cellDeadline = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS) * 1000;
assert(Number.isSafeInteger(cellDeadline) && cellDeadline > Date.now());
const deadline = cellDeadline - 60000;
const env = {
  PATH: process.env.PATH,
  HOME: root + "/home",
  TMPDIR: root + "/tmp",
  CI: "true",
  XDG_CONFIG_HOME: root + "/home/config",
  XDG_CACHE_HOME: root + "/home/cache",
  XDG_DATA_HOME: root + "/home/data",
  XDG_STATE_HOME: root + "/home/state",
  OPENCLAW_STATE_DIR: root + "/state",
  OPENCLAW_CONFIG_PATH: root + "/state/openclaw.json",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  npm_config_cache: root + "/npm-cache",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_loglevel: "error",
};
for (const p of [
  env.HOME,
  env.TMPDIR,
  env.OPENCLAW_STATE_DIR,
  root + "/workspace",
  "/tmp/openclaw",
]) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}
const phases = [];
const operations = new Set();
const abort = new AbortController();
let gateway;
let result;
let failure;
function launch(name, command, args, overrides = {}, diagnostic = false) {
  const stdout = fs.openSync(path.join(artifacts, name + ".stdout"), "w", 0o600);
  const stderr = fs.openSync(path.join(artifacts, name + ".stderr"), "w", 0o600);
  const started = Date.now();
  let ownedChild;
  /** @type {Error | undefined} */
  let operationError;
  const close = (async () => {
    const receipt = { name, code: null, signal: null, processTreeState: "unknown" };
    try {
      const timeoutMs = (diagnostic ? cellDeadline - 15000 : deadline) - Date.now();
      assert(timeoutMs > 0, "Diagnostic cell budget exhausted");
      receipt.code = await runManagedCommand({
        bin: command,
        args,
        cwd: root,
        env: { ...env, ...overrides },
        stdio: ["ignore", stdout, stderr],
        timeoutMs,
        signal: diagnostic ? undefined : abort.signal,
        timeoutKillGraceMs: 5000,
        abortKillGraceMs: 5000,
        signalKillGraceMs: 5000,
        cleanupDrainTimeoutMs: 5000,
        requireProcessTreeExit: true,
        onReady(child) {
          ownedChild = child;
          receipt.pid = child.pid;
          child.once("exit", (_code, signal) => {
            receipt.signal = signal;
          });
        },
      });
      receipt.processTreeState = "terminated";
    } catch (error) {
      operationError = toErrorObject(error, name + " failed");
      receipt.error = operationError.message.slice(0, 512);
      receipt.processTreeState = hasUnjoinedWork(error) ? "unjoined" : "terminated";
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      receipt.elapsedMs = Date.now() - started;
      phases.push(receipt);
      write("snapshot-cleanup-diagnostic-phases.json", phases);
    }
    return receipt;
  })().finally(() => operations.delete(operation));
  const operation = {
    get child() {
      return ownedChild;
    },
    get error() {
      return operationError;
    },
    close,
  };
  operations.add(operation);
  return operation;
}
async function run(name, command, args, overrides = {}, allowFailure = false, diagnostic = false) {
  const operation = launch(name, command, args, overrides, diagnostic);
  const receipt = await operation.close;
  if (operation.error) {
    throw operation.error;
  }
  if (!allowFailure) {
    assert.equal(receipt.code, 0, name + " failed; inspect private diagnostic log");
  }
  return receipt;
}
const timer = setTimeout(
  () => abort.abort(new Error("Packaged Doctor diagnostic deadline exceeded")),
  Math.max(1, deadline - Date.now()),
);
try {
  const baselineIntegrity =
    "sha512-/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA==";
  await run("baseline-pack", "npm", [
    "pack",
    "openclaw@2026.9.7",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    root,
  ]);
  const packed = JSON.parse(fs.readFileSync(path.join(artifacts, "baseline-pack.stdout"), "utf8"));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].integrity, baselineIntegrity);
  const baselineTar = path.join(root, packed[0].filename);
  assert.equal(
    "sha512-" + createHash("sha512").update(fs.readFileSync(baselineTar)).digest("base64"),
    baselineIntegrity,
  );
  await run("install-baseline", "npm", [
    "install",
    "-g",
    "--prefix",
    root + "/baseline",
    baselineTar,
    "--no-fund",
    "--no-audit",
  ]);
  await run("install-candidate", "npm", [
    "install",
    "-g",
    "--prefix",
    root + "/candidate",
    candidateTar,
    "--no-fund",
    "--no-audit",
  ]);
  const baselineRoot = root + "/baseline/lib/node_modules/openclaw";
  const candidateRoot = root + "/candidate/lib/node_modules/openclaw";
  const baselineIdentity = readWorkerCellPackageIdentity(baselineRoot);
  assert.equal(baselineIdentity.version, "2026.9.7");
  assert.equal(baselineIdentity.buildInfo.commit, "c074824a27c96d3983043f9eeb33823cd1772d8c");
  const extracted = root + "/candidate-identity";
  fs.mkdirSync(extracted);
  await run("extract-identity", "tar", [
    "-xf",
    candidateTar,
    "-C",
    extracted,
    "package/package.json",
    "package/openclaw.mjs",
    "package/dist",
  ]);
  const expected = readWorkerCellPackageIdentity(extracted + "/package");
  assert.equal(expected.buildInfo.commit, process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA);
  assert.equal(expected.version, "2026.10.3");
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(candidateRoot), expected);
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => {
    socket.close(resolve);
  });
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token: "synthetic-pr03-token" },
        reload: { mode: "off" },
      },
      plugins: { enabled: false },
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { every: "0m" } },
        entries: { main: { workspace: root + "/workspace" } },
      },
    }),
  );
  await run("seed-baseline", process.execPath, [
    baselineRoot + "/openclaw.mjs",
    "doctor",
    "--fix",
    "--non-interactive",
    "--no-workspace-suggestions",
  ]);
  const source = root + "/state/state/openclaw.sqlite";
  const db = new DatabaseSync(source, { readOnly: true });
  const baselineSchema = db.prepare("PRAGMA user_version").get().user_version;
  db.close();
  assert.equal(baselineSchema, 19);
  gateway = launch("baseline-gateway", process.execPath, [
    baselineRoot + "/openclaw.mjs",
    "gateway",
    "run",
    "--port",
    String(port),
  ]);
  let ready = false;
  const readyDeadline = Math.min(deadline, Date.now() + 120000);
  while (Date.now() < readyDeadline && operations.has(gateway)) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/readyz", {
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  assert(ready && gateway.child, "Actual baseline Gateway did not become ready");
  const gatewayPid = gateway.child.pid;
  const gatewayStart = fs.readFileSync("/proc/" + gatewayPid + "/stat", "utf8");
  gateway.child.kill("SIGTERM");
  const stopped = await gateway.close;
  if (gateway.error) {
    throw gateway.error;
  }
  assert.equal(stopped.signal, null);
  assert.equal(stopped.code, 0);
  const baseline = {
    version: "2026.9.7",
    commit: baselineIdentity.buildInfo.commit,
    integrity: baselineIntegrity,
    sha256: hash(fs.readFileSync(baselineTar)),
  };
  seedSnapshotCleanupRefusal({
    source,
    artifacts,
    candidateIdentity: expected,
    baseline,
    gatewayPid,
  });
  const doctorResultPath =
    "/tmp/openclaw/openclaw-update-doctor-" + process.pid + "-" + randomUUID() + ".json";
  const preload = (name) =>
    "--import=" + JSON.stringify(pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href);
  const doctor = await run(
    "candidate-doctor",
    process.execPath,
    [
      candidateRoot + "/openclaw.mjs",
      "doctor",
      "--fix",
      "--non-interactive",
      "--no-workspace-suggestions",
    ],
    {
      NODE_OPTIONS:
        preload("./snapshot-cleanup-refusal.mjs") + " " + preload("./packaged-doctor-passive.mjs"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: doctorResultPath,
    },
    true,
  );
  const records = snapshotEvidenceRecords(artifacts);
  const doctorResult = fs.existsSync(doctorResultPath)
    ? JSON.parse(fs.readFileSync(doctorResultPath, "utf8"))
    : undefined;
  const passive = fs
    .readdirSync(artifacts)
    .filter((name) => name.startsWith("passive-"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(artifacts, name), "utf8")));
  const targets = passive.flatMap((row) => row.targets);
  const launches = passive.flatMap((row) => row.launches);
  const requests = launches.flatMap((row) => row.requests);
  const passiveOverflow = passive.some((row) => row.overflow);
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(candidateRoot), expected);
  assert.equal(hash(fs.readFileSync(candidateTar)), expectedSha);
  result = {
    kind: "standalone-packaged-doctor-diagnostic",
    publishedUpdaterAcceptance: false,
    node: process.version,
    candidate: { sha256: expectedSha, build: expected.buildInfo },
    baseline,
    baselineSchema,
    actualGateway: { startDigest: hash(gatewayStart), close: stopped },
    doctor,
    doctorResult: doctorResult
      ? { status: doctorResult.status, failureFactCount: doctorResult.failureFacts?.length ?? 0 }
      : null,
    observations: {
      doctors: records.doctors.length,
      doctorResults: records.doctors.filter((row) => row.result).length,
      nativeRequests: records.natives.length,
      requiredRequests: records.natives.filter((row) => row.binding).length,
      selectedFaults: records.copies.length,
    },
    passive: {
      processes: passive.length,
      targetEvents: passive.reduce((count, row) => count + row.counts.targets, 0),
      targetAdmissionEvents: passiveOverflow
        ? null
        : targets.filter((row) => row.phase === "target-admission").length,
      existingTargetEvents: passiveOverflow
        ? null
        : targets.filter((row) => row.phase === "existing-target").length,
      originalSourceTargets: passiveOverflow
        ? null
        : targets.filter((row) => row.originalSource).length,
      launches: passive.reduce((count, row) => count + row.counts.launches, 0),
      closedLaunches: passiveOverflow ? null : launches.filter((row) => row.close).length,
      requests: passiveOverflow ? null : requests.length,
      matchingSourceRequests: passiveOverflow
        ? null
        : requests.filter((row) => row.sourceMatches).length,
      gatewayPresentRequests: passiveOverflow
        ? null
        : requests.filter((row) => row.gatewayPresent === true).length,
      gatewayUnknownRequests: passiveOverflow
        ? null
        : requests.filter((row) => typeof row.gatewayPresent !== "boolean").length,
      overflow: passiveOverflow,
      inventorySha256: hash(JSON.stringify(passive)),
      inventoryOmitted: true,
    },
    packageUnchanged: true,
  };
  write("snapshot-cleanup-diagnostic.json", result);
  assert.equal(
    records.copies.length,
    1,
    "Diagnostic did not observe exactly one selected fault; inspect independent counts",
  );
  assert.equal(doctor.signal, null);
  assert.notEqual(doctor.code, 0, "Actual Doctor CLI must refuse the selected fault");
  assert.equal(doctorResult?.status, "error", "Actual Doctor result must report error");
  assertSnapshotDoctorCaptureRefusal(artifacts);
  const compact = summarizeSnapshotCleanupEvidence(artifacts);
  assert.equal(compact.overflow, false);
  // No updater ran: its missing public result is explicit, never fabricated.
  assert.deepEqual(compact.unknown, ["outer-result"]);
  write("summary.json", {
    status: "passed",
    baseline: { spec: "openclaw@2026.9.7", version: "2026.9.7" },
    candidate: { kind: "tarball", version: expected.version },
    scenario: "snapshot-cleanup-diagnostic",
    installedVersion: expected.version,
    candidateInstallMode: "npm",
    updateRestartMode: "manual",
    updateOutcome: "diagnostic-only-no-updater",
    phases: [],
  });
} catch (error) {
  failure = error;
  process.exitCode = 1;
} finally {
  if (gateway && operations.has(gateway)) {
    gateway.child?.kill("SIGTERM");
  }
  await Promise.all([...operations].map((operation) => operation.close));
  clearTimeout(timer);
  const unjoined =
    phases.some((phase) => phase.processTreeState === "unjoined") || hasUnjoinedWork(failure);
  write("snapshot-cleanup-diagnostic.json", {
    ...result,
    kind: "standalone-packaged-doctor-diagnostic",
    publishedUpdaterAcceptance: false,
    failure: failure ? String(failure.message).slice(0, 512) : null,
    unjoined,
    phases,
  });
  if (!unjoined) {
    try {
      writeSnapshotCleanupEvidence(artifacts);
      await run(
        "capture-diagnostics",
        process.execPath,
        [
          fileURLToPath(new URL("./diagnostics.mjs", import.meta.url)),
          "capture",
          artifacts,
          "snapshot-cleanup-diagnostic",
          String(process.exitCode || 0),
        ],
        {},
        false,
        true,
      );
    } catch (captureError) {
      process.exitCode = 1;
      console.error(
        "Diagnostic capture failed after primary outcome:",
        failure?.message ?? "none",
        captureError.message,
      );
    }
  }
}
