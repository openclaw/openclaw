import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { childOf } from "./fixture-files.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const helper = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../lib/openclaw-e2e-instance.sh",
);
const crashMarker = "upgrade-survivor crashing candidate refused Gateway startup";
const restartReason = "runtime-verification-failed";
const gatewayStartupSteps = new Set(["candidate-gateway-startup", "Checking Gateway startup"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function context(packageRoot, candidateTarball) {
  const required = (key) => {
    assert(path.isAbsolute(process.env[key] ?? ""), `Missing isolated ${key}`);
    return fs.realpathSync(process.env[key]);
  };
  const runtime = required("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const artifacts = required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const state = required("OPENCLAW_STATE_DIR");
  const config = process.env.OPENCLAW_CONFIG_PATH;
  assert(childOf(runtime, state) && config && childOf(state, config));
  assert(process.env.OPENCLAW_E2E_COMMAND_TIMEOUT, "Pass the survivor COMMAND_TIMEOUT");
  assert(packageRoot && path.isAbsolute(packageRoot), "Missing installed package root");
  assert(candidateTarball && fs.existsSync(candidateTarball), "Missing frozen candidate tarball");
  return {
    runtime,
    artifacts,
    state,
    config,
    packageRoot: fs.realpathSync(packageRoot),
    candidateTarball,
  };
}

function cliEnv() {
  const env = { ...process.env };
  for (const key of [
    "CI",
    "OPENCLAW_NO_PROMPT",
    "OPENCLAW_NO_ONBOARD",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_ALLOW_ROOT",
    "VITEST",
    "NODE_ENV",
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(ctx, label, args, expectedStatus) {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; shift; openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" "$@"',
      "update-recovery-crash-cli",
      helper,
      process.execPath,
      path.join(ctx.packageRoot, "openclaw.mjs"),
      ...args,
    ],
    { env: cliEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const artifact = (suffix) => path.join(ctx.artifacts, `update-recovery-crash-${label}.${suffix}`);
  fs.writeFileSync(artifact("log"), result.stdout ?? "", { flag: "wx" });
  fs.writeFileSync(artifact("err"), result.stderr ?? "", { flag: "wx" });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `Installed CLI ${label} exited ${result.status}`);
  return {
    stdout: result.stdout,
    text: stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).replaceAll("\r", ""),
  };
}

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  assert(match, `Unsupported candidate version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// A newer release whose only defect is a Gateway that exits before listening:
// staging and Doctor pass, so validation fails at candidate-gateway-startup.
function packCrashingCandidate(ctx, installedVersion) {
  const fixture = fs.mkdtempSync(path.join(ctx.runtime, "crashing-candidate-"));
  const tar = (args) => {
    const result = spawnSync("tar", args, { encoding: "utf8" });
    assert.equal(result.status, 0, `tar ${args[0]} failed: ${result.stderr}`);
  };
  tar(["-xzf", ctx.candidateTarball, "-C", fixture]);
  const root = path.join(fixture, "package");
  const version = nextPatchVersion(installedVersion);
  for (const relative of ["package.json", "dist/build-info.json"]) {
    const file = path.join(root, relative);
    fs.writeFileSync(file, `${JSON.stringify({ ...readJson(file), version }, null, 2)}\n`);
  }
  const entry = path.join(root, "dist/index.js");
  const source = fs.readFileSync(entry, "utf8");
  const shebang = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
  const guard = `if (process.argv.includes("--update-canary")) { process.stderr.write(${JSON.stringify(`${crashMarker}\n`)}); process.exit(1); }\n`;
  fs.writeFileSync(entry, `${shebang}${guard}${source.slice(shebang.length)}`);
  // Staged package verification hashes dist content; keep it passing so the canary runs.
  const inventoryFile = path.join(root, "dist/postinstall-content-inventory.json");
  const inventory = readJson(inventoryFile);
  const edited = new Set(["dist/index.js", "dist/build-info.json"]);
  for (const item of inventory.filter((candidate) => edited.has(candidate.path))) {
    const bytes = fs.readFileSync(path.join(root, item.path));
    Object.assign(item, { sha256: hash(bytes), size: bytes.length });
    edited.delete(item.path);
  }
  assert.equal(edited.size, 0, `Content inventory lacks ${[...edited].join(", ")}`);
  fs.writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
  const tarball = path.join(fixture, "crashing-candidate.tgz");
  tar(["-czf", tarball, "-C", fixture, "package"]);
  fs.rmSync(root, { recursive: true, force: true });
  return { tarball, version, sha256: hash(fs.readFileSync(tarball)) };
}

function excerpt(text, first, last) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(first));
  const end = lines.findIndex((line, index) => index >= start && line.includes(last));
  assert(start >= 0 && end >= start, `Missing ordered output from "${first}" to "${last}"`);
  return lines.slice(start, end + 1);
}

function run(ctx) {
  const expected = readJson(path.join(ctx.artifacts, "candidate-package-identity.json"));
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(ctx.packageRoot), {
    version: expected.version,
    buildInfo: expected.buildInfo,
    files: expected.files,
  });
  const version = expected.version;
  // An unlisted dist file makes the installed runtime unverifiable, so restart stays unsafe.
  fs.writeFileSync(
    path.join(ctx.packageRoot, "dist/upgrade-survivor-unexpected.js"),
    "export {};\n",
    { flag: "wx" },
  );
  const installed = readWorkerCellPackageIdentity(ctx.packageRoot);
  const configSha256 = hash(fs.readFileSync(ctx.config));
  const crashing = packCrashingCandidate(ctx, version);

  const update = runCli(
    ctx,
    "update",
    ["update", "--tag", `file:${crashing.tarball}`, "--yes", "--no-restart"],
    1,
  );
  const serving = "Gateway: verified serving after update failure.";
  const recovery = `Recovery: verified serving ${version}; restart remains unsafe (${restartReason}).`;
  const nextAction = `The gateway is serving ${version} and passed recovery verification, but restarting it is not verified safe (${restartReason}).`;
  for (const line of [serving, recovery, nextAction]) {
    assert(update.text.includes(line), `Update output lacks: ${line}`);
  }
  assert(
    !update.text.includes("did not pass verification"),
    "Verified serving Gateway was described as failing verification",
  );
  const rendered = excerpt(update.text, serving, nextAction);
  const reportPath = /^Report: (.+)$/mu.exec(update.stdout)?.[1]?.trim();
  assert(reportPath && childOf(ctx.state, reportPath), "Update report was not saved in state");
  const report = fs.readFileSync(reportPath, "utf8");
  fs.writeFileSync(path.join(ctx.artifacts, "update-recovery-crash-report.md"), report, {
    flag: "wx",
  });
  const reportLines = report.split("\n");
  // Advisory warnings yield the length-bounded markdown before these facts.
  assert(reportLines.includes(recovery), "Saved report lacks the recovery line");
  assert(
    reportLines.some((line) => line.startsWith("Verification: version verified;")),
    "Saved report lacks the verification line",
  );
  // The next action line continues with triage guidance.
  assert(report.includes(nextAction), "Saved report lacks the next action");

  const status = JSON.parse(runCli(ctx, "status", ["update", "status", "--json"], 0).stdout);
  const record = status.lastRun;
  assert.equal(status.activeRun, undefined);
  assert.equal(record?.status, "failed");
  const startup = record.steps.find(
    (step) => gatewayStartupSteps.has(step.step) && step.status === "failed",
  );
  assert(startup, "Validation did not fail at candidate Gateway startup");
  assert(JSON.stringify(startup).includes(crashMarker), "Startup failure lacks the candidate exit");
  assert(!record.steps.some((step) => step.step === "package-swap"), "Failed validation swapped");
  const probe = record.steps.findLast((step) => step.step === "gateway recovery verification");
  assert.equal(probe?.exitCode, 0, "Recovery probe did not verify the serving Gateway");
  assert(!probe.failureFacts?.length, "Recovery probe recorded failures");
  assert.deepEqual(record.verification?.recovery, {
    serviceRestartSafe: false,
    reason: restartReason,
  });
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(ctx.packageRoot), installed);
  assert.equal(hash(fs.readFileSync(ctx.config)), configSha256, "Failed update rewrote config");

  fs.writeFileSync(
    path.join(ctx.artifacts, "update-recovery-crashing-candidate.json"),
    `${JSON.stringify(
      {
        installed: { version, commit: expected.buildInfo.commit },
        crashingCandidate: { version: crashing.version, sha256: crashing.sha256 },
        runId: record.runId,
        failedStep: startup.step,
        recovery: record.verification.recovery,
        rendered,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(rendered.join("\n"));
}

const [packageRoot, candidateTarball] = process.argv.slice(2);
run(context(packageRoot, candidateTarball));
