import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { packFirstHopUpdateFixture } from "../update-first-hop-package-fixtures.mjs";
import { selectInstalledRecoveryCuts } from "./installed-recovery-cases.mjs";
import { runInstalledRecoveryCommand } from "./installed-recovery-command.mjs";
import {
  assertInstalledRecoveryConfig,
  assertPackageTree,
  assertRetirementCut,
  capturePackageTree,
  fileDigest,
  fileIdentity,
  installedRecoveryEvidenceMode,
  openInstalledRecoveryEvidence,
  parseRecoveryCommand,
  readActivation,
  sha256,
  writeInstalledRecoveryEvidence as write,
} from "./installed-recovery-observations.mjs";
import { extractPackedRecoveryHelper } from "./installed-recovery-package.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const packedManifest = (tarball) =>
  JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));

async function main([artifacts, prefix, tarball, configPath, summary, selectedCut = ""]) {
  const cuts = selectInstalledRecoveryCuts(selectedCut);
  // The survivor owner budgets the whole update. A shorter local watchdog can
  // kill candidate preparation before the intended interruption checkpoint.
  const timeout = process.env.OPENCLAW_E2E_COMMAND_TIMEOUT;
  assert(timeout !== undefined, "missing survivor command timeout");
  assert.equal(
    process.platform,
    "linux",
    "installed recovery cell owns a disposable Linux container",
  );
  for (const file of [artifacts, prefix, tarball, configPath, summary]) {
    assert(file && path.isAbsolute(file));
  }
  const root = fs.realpathSync(path.join(prefix, "lib/node_modules/openclaw"));
  const bin = path.join(prefix, "bin/openclaw");
  const node = fs.realpathSync(process.execPath);
  assert(
    !node.startsWith(`${prefix}${path.sep}`),
    "recovery Node must outlive the installed package",
  );
  const baseline = packedManifest(tarball);
  assert.equal(read(path.join(root, "package.json")).version, baseline.version);
  const anchor = path.join(
    path.dirname(root),
    `.openclaw.package-activation-${sha256(root).slice(0, 24)}`,
  );
  const helper = path.join(`${anchor}.control`, "recovery.mjs");
  const journal = path.join(`${anchor}.control`, "operation.sqlite");
  const fault = fileURLToPath(new URL("./installed-recovery-fault.mjs", import.meta.url));
  const config = fs.readFileSync(configPath);
  const alternate = path.join(artifacts, "independent-recovery.mjs");
  extractPackedRecoveryHelper(tarball, alternate);
  const helperDigest = fileDigest(alternate);

  // A deliberately small external environment cannot inherit the killed CLI's
  // loader, worker handoff, lease, or in-progress update authority.
  const env = Object.fromEntries(
    [
      "HOME",
      "PATH",
      "TMPDIR",
      "LANG",
      "TZ",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "npm_config_prefix",
      "NPM_CONFIG_PREFIX",
      "npm_config_cache",
      "NPM_CONFIG_CACHE",
      "GATEWAY_AUTH_TOKEN_REF",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  Object.assign(env, {
    CI: "true",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
  });
  const commands = [];
  const run = async (directory, name, command, args, faultCut) => {
    console.log(`[installed-recovery] ${path.basename(directory)}: ${name}`);
    const stdout = path.join(directory, `${name}.out`);
    const stderr = path.join(directory, `${name}.err`);
    const childEnv = { ...env };
    if (faultCut) {
      const spec = path.join(directory, `${name}.fault.json`);
      write(spec, { root, anchor, helper, journal, cut: faultCut, evidence: `${spec}.observed` });
      childEnv.OPENCLAW_SURVIVOR_INSTALLED_RECOVERY_FAULT = spec;
      childEnv.NODE_OPTIONS = `--import=${fault}`;
    }
    const result = await runInstalledRecoveryCommand({
      bin: command,
      args,
      env: childEnv,
      stdout,
      stderr,
      timeout,
      timeoutKillGraceMs: 10_000,
      record: (outcome) => {
        evidence.current = {
          cut: path.relative(artifacts, directory) || null,
          name,
          stdout: path.relative(artifacts, stdout),
          stderr: path.relative(artifacts, stderr),
          ...outcome,
        };
        write(summary, evidence);
      },
    });
    const { status } = result;
    commands.push({ ...evidence.current, preload: faultCut ?? null });
    assert.equal(status === 0, !faultCut, `${name}: exit ${status}`);
    return result;
  };
  const settingsUnchanged = () =>
    assert.deepEqual(fs.readFileSync(configPath), config, "full config bytes changed");
  const launcher = () => ({
    inode: fileIdentity(bin),
    link: fs.lstatSync(bin).isSymbolicLink() ? fs.readlinkSync(bin) : null,
    digest: fileDigest(bin),
  });
  const operationIds = new Set();
  const rows = [];
  const evidence = {
    status: "running",
    runDirectory: path.basename(artifacts),
    scope: "installed-current-writer-process-interruption",
    selectedCuts: cuts.map(([, cut]) => cut),
    artifactSha256: fileDigest(tarball),
    baselineVersion: baseline.version,
    helperSha256: helperDigest,
    node,
    rows,
    commands,
  };
  write(summary, evidence);

  for (const [sequence, cut] of cuts) {
    const directory = path.join(artifacts, cut);
    fs.mkdirSync(directory);
    fs.chmodSync(directory, installedRecoveryEvidenceMode(artifacts, true));
    const target = path.join(directory, "candidate.tgz");
    const fixture = packFirstHopUpdateFixture(tarball, target, sequence);
    write(path.join(directory, "candidate-fixture.json"), fixture);
    const expected = packedManifest(target);
    assert.notEqual(expected.version, read(path.join(root, "package.json")).version);
    assert.deepEqual(expected.openclaw.schemaVersions, baseline.openclaw.schemaVersions);
    const originalTree = capturePackageTree(root);
    const originalLauncher = launcher();
    const interrupted = await run(
      directory,
      "displacement",
      node,
      [bin, "update", "--tag", `file:${target}`, "--yes", "--no-restart", "--json"],
      "displaced",
    );
    const observed = read(path.join(directory, "displacement.fault.json.observed"));
    assert.equal(observed.cut, "displaced");
    assert.deepEqual(
      readActivation(journal),
      observed.row,
      "dead writer changed the captured journal",
    );
    const descriptor = JSON.parse(observed.row.descriptor_json);
    // This current-writer cell requires full seals, not legacy identity-only
    // recovery: both owner-covered trees must undergo canonical tightening.
    for (const selected of [descriptor.previous, descriptor.candidate]) {
      assert.match(selected.digest, /^[a-f0-9]{64}$/u);
    }
    const printed = parseRecoveryCommand(`${interrupted.stdout}\n${interrupted.stderr}`);
    assert.deepEqual(printed, { node, helper, anchor, operation: descriptor.operationId });
    assert(
      !operationIds.has(printed.operation),
      "each subsequent update must acquire a new operation",
    );
    operationIds.add(printed.operation);
    assert.equal(fs.existsSync(root), false, "live package must actually be absent");
    assert.equal(fs.existsSync(bin), false, "installed CLI must actually be unusable");
    const previousTree = assertPackageTree(
      originalTree,
      capturePackageTree(path.join(anchor, "previous")),
      { tightenPermissions: true },
    );
    const previousIdentity = fileIdentity(path.join(anchor, "previous"));
    let candidateTree = capturePackageTree(path.join(anchor, "candidate"));
    assert.equal(read(path.join(anchor, "candidate/package.json")).version, expected.version);
    assert.equal(
      fileDigest(helper),
      helperDigest,
      "printed helper must come from the current artifact",
    );
    const helperIdentity = fileIdentity(helper);
    settingsUnchanged();

    const recovery = async (name, action, { selectedHelper = printed.helper, faultCut } = {}) => {
      const result = await run(
        directory,
        name,
        printed.node,
        [selectedHelper, "--anchor", printed.anchor, "--operation", printed.operation, action],
        faultCut,
      );
      if (faultCut) {
        return result;
      }
      const status = JSON.parse(result.stdout.trim());
      assert.equal(status.operationId, printed.operation);
      assert.equal(status.installKey, root);
      settingsUnchanged();
      return status;
    };
    assert.equal((await recovery("missing-status", "status")).phase, "publishing");
    assertPackageTree(previousTree, capturePackageTree(path.join(anchor, "previous")));
    assertPackageTree(candidateTree, capturePackageTree(path.join(anchor, "candidate")));
    for (const name of ["repair", "repeat-repair"]) {
      assert.equal((await recovery(name, "repair")).phase, "publication-complete");
      candidateTree = assertPackageTree(candidateTree, capturePackageTree(root), {
        tightenPermissions: name === "repair",
      });
      assertPackageTree(previousTree, capturePackageTree(path.join(anchor, "previous")));
      assert.equal(fileIdentity(path.join(anchor, "previous")), previousIdentity);
      assert.equal(fileIdentity(helper), helperIdentity);
      assert.equal(fileDigest(helper), helperDigest);
      assert.equal(launcher().link, originalLauncher.link);
      assert.equal(launcher().digest, originalLauncher.digest);
    }
    const selectedLauncher = launcher();
    await recovery("retirement", "retire", { faultCut: cut });
    const retirement = read(path.join(directory, "retirement.fault.json.observed"));
    assertRetirementCut(cut, retirement, anchor, helper);
    assert.deepEqual(readActivation(journal), retirement.row);
    assertPackageTree(candidateTree, capturePackageTree(root));
    assert.deepEqual(launcher(), selectedLauncher);
    settingsUnchanged();

    // unlink-helper intent is already a completed receipt. Earlier cuts still
    // require the original helper; an independent copy is never recovery authority.
    if (!cut.startsWith("helper-")) {
      assert.equal((await recovery("resume-retirement", "retire")).phase, "complete");
    }
    assert.equal(
      (await recovery("completed-status", "status", { selectedHelper: alternate })).phase,
      "complete",
    );
    assert.equal(
      (await recovery("archive-completed", "retire", { selectedHelper: alternate })).phase,
      "complete",
    );
    assert.equal(fs.existsSync(journal), false, "completed custody must stop blocking admission");
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(fs.existsSync(helper), false);
    const archived = path.join(
      `${anchor}.superseded-${printed.operation}`,
      "control/operation.sqlite",
    );
    assert.equal(
      JSON.parse(readActivation(archived).descriptor_json).operationId,
      printed.operation,
    );
    assertPackageTree(candidateTree, capturePackageTree(root));
    assert.deepEqual(launcher(), selectedLauncher);
    settingsUnchanged();
    rows.push({
      cut,
      operationId: printed.operation,
      installedVersion: expected.version,
      missingCli: true,
      originalWriterJoined: true,
      originalHelperRepairs: 2,
      interruptedPhase: retirement.row.phase,
      completedViaIndependentHelper: true,
      packagePreserved: true,
      launchersPreserved: true,
      fullConfigPreserved: true,
    });
    write(summary, evidence);
    fs.unlinkSync(target);
  }

  const target = path.join(artifacts, "next-update.tgz");
  packFirstHopUpdateFixture(tarball, target, 7);
  const expected = packedManifest(target);
  const next = await run(artifacts, "next-update", node, [
    bin,
    "update",
    "--tag",
    `file:${target}`,
    "--yes",
    "--no-restart",
    "--json",
  ]);
  // Healthy update runs Doctor and may persist bookkeeping. Status inspection
  // must preserve those new bytes as well as the configured operator settings.
  const updatedConfig = fs.readFileSync(configPath);
  const printed = parseRecoveryCommand(`${next.stdout}\n${next.stderr}`);
  assert.deepEqual(printed, { node, helper, anchor, operation: printed.operation });
  assert(!operationIds.has(printed.operation), "real next update must acquire distinct custody");
  assert.deepEqual(read(path.join(root, "package.json")), expected);
  const installedTree = capturePackageTree(root);
  const installedLauncher = launcher();
  const receipt = readActivation(journal);
  const descriptor = JSON.parse(receipt.descriptor_json);
  assert.equal(descriptor.operationId, printed.operation);
  assert.equal(receipt.phase, "anchor-retired");
  assert.deepEqual(JSON.parse(receipt.intent_json), {
    kind: "unlink-helper",
    identity: descriptor.helperIdentity,
    selected: "candidate",
  });
  // Normal retirement retains this completed receipt. Inspection by a copy of
  // the same artifact must not turn it back into recovery custody.
  const completed = await run(artifacts, "next-update-status", node, [
    alternate,
    "--anchor",
    anchor,
    "--operation",
    printed.operation,
    "status",
  ]);
  assert.deepEqual(JSON.parse(completed.stdout.trim()), {
    phase: "complete",
    operationId: printed.operation,
    installKey: root,
  });
  assert.deepEqual(readActivation(journal), receipt);
  assert.equal(fs.existsSync(anchor), false);
  assert.equal(fs.existsSync(helper), false);
  assertPackageTree(installedTree, capturePackageTree(root));
  assert.deepEqual(launcher(), installedLauncher);
  assertInstalledRecoveryConfig(config, updatedConfig, fs.readFileSync(configPath));
  evidence.nextUpdate = {
    exitCode: next.status,
    operationId: printed.operation,
    installedVersion: expected.version,
    receiptPhase: receipt.phase,
    status: "complete",
  };
  fs.unlinkSync(target);
  evidence.status = "passed";
  write(summary, evidence);
  console.log(
    `[installed-recovery] PASS: ${rows.length} retirement cuts, missing CLI recovery, and next update`,
  );
}

let driverError;
let failed = false;
let diagnosticUnavailable = false;
try {
  const artifacts = process.argv[2];
  assert(artifacts && path.isAbsolute(artifacts));
  // Parse errors and assertion values can contain config bytes in formats the
  // text redactor cannot recognize. Keep the entire exception private, even
  // when failure precedes the first managed command or summary update.
  driverError = openInstalledRecoveryEvidence(path.join(artifacts, "driver.err"));
  await main(process.argv.slice(2));
} catch (error) {
  failed = true;
  try {
    assert(driverError !== undefined);
    fs.writeFileSync(driverError, `${inspect(error, { customInspect: false })}\n`);
  } catch {
    diagnosticUnavailable = true;
  }
} finally {
  if (driverError !== undefined) {
    try {
      fs.closeSync(driverError);
    } catch {
      failed = true;
      diagnosticUnavailable = true;
    }
  }
  if (failed) {
    console.error(
      diagnosticUnavailable
        ? "[installed-recovery] private driver diagnostic unavailable"
        : "[installed-recovery] inspect driver.err in the private run evidence",
    );
    console.error("[installed-recovery] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
