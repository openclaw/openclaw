import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const identity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const authoredSettings = (file) => {
  const config = read(file);
  const { mode, port, bind, reload, auth } = config.gateway;
  return { gateway: { mode, port, bind, reload, auth }, pluginsEnabled: config.plugins.enabled };
};
const packageIdentity = (root) => ({
  version: read(path.join(root, "package.json")).version,
  build: read(path.join(root, "dist/build-info.json")),
  manifest: digest(path.join(root, "package.json")),
});

// Ignore timestamps and inode changes from publication, but inventory every
// directory, regular-file byte, mode, and symlink target without following links.
function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    assert(kind !== "file" || stat.isFile(), `Unsupported package entry: ${file}`);
    hash.update(
      JSON.stringify([
        relative,
        kind,
        stat.mode & 0o7777,
        kind === "file" ? digest(file) : kind === "link" ? fs.readlinkSync(file) : null,
      ]),
    );
    if (kind === "directory") {
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(relative, name));
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

export function assertPackageRecoveryEvidence(value) {
  assert.equal(value.status, "passed");
  if (value.targetSelector === "unmodified-released-9.8") {
    assert.equal(value.baseline.version, "2026.9.7");
    assert.equal(value.candidate.version, "2026.9.8");
    assert.equal(value.interruption.writerVersion, "2026.9.7");
    assert.equal(value.interruption.phase, "publication-complete");
    assert.deepEqual(value.firstHop, {
      status: "blocked-before-staging",
      reason: "update-recovery-pending",
      installedVersion: "2026.9.8",
      targetWasAbsent: true,
      candidateCodeInvoked: false,
    });
    return;
  }
  assert(["2026.9.8", "2026.9.9"].includes(value.baseline.version));
  assert.match(value.candidate.tarballSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(value.baseline.build.buildId, value.candidate.build.buildId);
  assert.equal(value.interruption.phase, "publication-complete");
  assert(["publication-complete", "verification"].includes(value.interruption.cut));
  assert.equal(value.interruption.writerVersion, value.baseline.version);
  assert.equal(value.interruption.helperPreserved, true);
  assert.equal(value.repair.exitCode, 0);
  assert.equal(value.repair.retainedBytesPreserved, true);
  assert.equal(value.repair.candidateUnchanged, true);
  assert.equal(value.repair.settingsPreserved, true);
  assert.equal(value.repeatRepair.exitCode, 0);
  assert.equal(value.repeatRepair.settingsPreserved, true);
  assert.equal(value.nextUpdate.exitCode, 0);
  assert.notEqual(value.nextUpdate.installed.version, value.candidate.version);
  assert.deepEqual(value.nextUpdate.installed, value.nextUpdate.expected);
  assert.equal(value.nextUpdate.retainedBytesPreserved, true);
  assert.equal(value.nextUpdate.settingsPreserved, true);
  assert.equal(value.targetSelector, "installed-candidate");
  for (const version of [value.candidate.version, value.nextUpdate.installed.version]) {
    assert.match(version, /^\d{4}\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu);
  }
}

function main([command, artifacts, ...args]) {
  const file = path.join(artifacts, "package-activation-recovery.json");
  const faultFile = path.join(artifacts, "package-activation-fault.json");
  if (command === "setup") {
    const [installRoot, candidateTarball, cut, configPath] = args;
    const root = fs.realpathSync(installRoot);
    const baseline = packageIdentity(root);
    assert(["2026.9.7", "2026.9.8", "2026.9.9"].includes(baseline.version));
    assert(["publication-complete", "verification"].includes(cut));
    const packed = (relative) =>
      JSON.parse(
        execFileSync("tar", ["-xOf", candidateTarball, `package/${relative}`], {
          encoding: "utf8",
        }),
      );
    const anchor = path.join(
      path.dirname(root),
      `.openclaw.package-activation-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    );
    const candidate = {
      version: packed("package.json").version,
      build: packed("dist/build-info.json"),
      tarballSha256: digest(candidateTarball),
    };
    assert.notEqual(baseline.build.buildId, candidate.build.buildId);
    const fault = {
      journal: path.join(`${anchor}.control`, "operation.sqlite"),
      evidence: path.join(artifacts, "package-activation-cut.json"),
      cut,
      previousRoot: path.join(anchor, "previous"),
    };
    // A reused artifact directory must not make this invocation look already
    // interrupted or let an old cut marker fail an unrelated Doctor child.
    fs.rmSync(fault.evidence, { force: true });
    fs.rmSync(`${fault.evidence}.doctor`, { force: true });
    write(faultFile, fault);
    write(file, {
      status: "running",
      baseline,
      candidate,
      root,
      anchor,
      configPath,
      authoredSettings: authoredSettings(configPath),
      targetSelector: "installed-candidate",
    });
    return;
  }
  const value = read(file);
  const fault = read(faultFile);
  const save = () => write(file, value);
  const assertSettings = () => {
    assert.deepEqual(
      authoredSettings(value.configPath),
      value.authoredSettings,
      "authored settings changed",
    );
    return true;
  };
  const assertCandidate = () => {
    const actual = packageIdentity(value.root);
    assert.equal(actual.version, value.candidate.version);
    assert.deepEqual(actual.build, value.candidate.build);
    if (value.interruption?.candidateTreeDigest) {
      assert.equal(
        treeDigest(value.root),
        value.interruption.candidateTreeDigest,
        "candidate package tree changed",
      );
    }
    return actual;
  };
  const retainedRoot = `${value.anchor}.superseded-${value.interruption?.operationId}`;
  const preserved = () => {
    assert.equal(
      treeDigest(path.join(retainedRoot, "previous")),
      value.interruption.previousTreeDigest,
      "retained package tree changed",
    );
    assert.equal(
      identity(path.join(retainedRoot, "previous")),
      value.interruption.previousIdentity,
    );
    assert.equal(
      digest(path.join(retainedRoot, "previous/package.json")),
      value.interruption.previousManifest,
    );
    assert.equal(
      digest(path.join(retainedRoot, "control/recovery.mjs")),
      value.interruption.helperDigest,
    );
    return true;
  };
  if (command === "interrupted") {
    assert.notEqual(Number(args[0]), 0, "injected failure must reach the real CLI result");
    const cut = read(fault.evidence);
    assert.equal(cut.cut, fault.cut);
    if (fault.cut === "verification") {
      assert.equal(read(`${fault.evidence}.doctor`).exitCode, 1);
    }
    const db = new DatabaseSync(fault.journal, { readOnly: true });
    let row;
    try {
      row = db.prepare("SELECT * FROM package_activation WHERE slot = 1").get();
    } finally {
      db.close();
    }
    assert.equal(
      row.phase,
      "publication-complete",
      "fault must leave the real publication completed, not a rolled-back or fabricated journal",
    );
    const descriptor = JSON.parse(row.descriptor_json);
    assert.equal(descriptor.previous.version, value.baseline.version);
    assert.equal(descriptor.candidate.version, value.candidate.version);
    const helperDigest = digest(path.join(`${value.anchor}.control`, "recovery.mjs"));
    assert.equal(helperDigest, descriptor.helperDigest);
    assertCandidate();
    const previous = path.join(value.anchor, "previous/package.json");
    const before = fs.statSync(previous, { bigint: true });
    const previousManifest = digest(previous);
    if (fault.cut === "publication-complete") {
      // Same inode and bytes, changed ctime: models a benign cleanup metadata change.
      const mode = Number(before.mode & 0o777n);
      fs.chmodSync(previous, mode ^ 0o100);
      fs.chmodSync(previous, mode);
      assert.equal(fs.statSync(previous, { bigint: true }).ino, before.ino);
      assert.notEqual(fs.statSync(previous, { bigint: true }).ctimeNs, before.ctimeNs);
      assert.equal(digest(previous), previousManifest);
    } else {
      assert.equal(
        previousManifest,
        read(`${fault.evidence}.doctor`).manifestDigest,
        "Doctor must change rollback bytes before failing verification",
      );
    }
    value.interruption = {
      phase: row.phase,
      operationId: descriptor.operationId,
      writerVersion: value.baseline.version,
      helperDigest,
      helperPreserved: true,
      previousManifest,
      previousTreeDigest: treeDigest(path.join(value.anchor, "previous")),
      candidateTreeDigest: treeDigest(value.root),
      previousIdentity: identity(path.join(value.anchor, "previous")),
      cut: fault.cut,
    };
  } else if (command === "stranded") {
    assert.equal(value.baseline.version, "2026.9.7");
    assert.equal(value.candidate.version, "2026.9.8");
    assert.notEqual(Number(args[0]), 0);
    const output = fs.readFileSync(path.join(artifacts, "stranded-update.json"), "utf8");
    const result = JSON.parse(output.slice(output.indexOf("{")));
    assert.equal(
      result.reason,
      "update-recovery-pending",
      "negative control must refuse the existing record, not the nonexistent target or another gate",
    );
    assertCandidate();
    const row = read(fault.evidence).row;
    const db = new DatabaseSync(fault.journal, { readOnly: true });
    try {
      const actual = db.prepare("SELECT * FROM package_activation WHERE slot = 1").get();
      assert.deepEqual(
        { ...actual },
        row,
        "the rejected old updater must not alter its recovery obligation",
      );
    } finally {
      db.close();
    }
    value.status = "passed";
    value.targetSelector = "unmodified-released-9.8";
    value.firstHop = {
      status: "blocked-before-staging",
      reason: result.reason,
      installedVersion: "2026.9.8",
      targetWasAbsent: true,
      candidateCodeInvoked: false,
    };
    assertPackageRecoveryEvidence(value);
  } else if (command === "repaired") {
    assert.equal(Number(args[0]), 0, "public candidate repair must succeed");
    value.repair = {
      exitCode: 0,
      retainedBytesPreserved: preserved(),
      candidateUnchanged: Boolean(assertCandidate()),
      settingsPreserved: assertSettings(),
    };
  } else if (command === "repeat") {
    assert.equal(Number(args[0]), 0);
    preserved();
    assertCandidate();
    value.repeatRepair = { exitCode: 0, settingsPreserved: assertSettings() };
  } else if (command === "next") {
    assert.equal(Number(args[0]), 0, "a distinct subsequent update must actually install");
    const future = args[1];
    const expected = {
      version: JSON.parse(
        execFileSync("tar", ["-xOf", future, "package/package.json"], { encoding: "utf8" }),
      ).version,
      build: JSON.parse(
        execFileSync("tar", ["-xOf", future, "package/dist/build-info.json"], { encoding: "utf8" }),
      ),
      manifest: createHash("sha256")
        .update(execFileSync("tar", ["-xOf", future, "package/package.json"]))
        .digest("hex"),
    };
    value.nextUpdate = {
      exitCode: 0,
      expected,
      installed: packageIdentity(value.root),
      retainedBytesPreserved: preserved(),
      settingsPreserved: assertSettings(),
    };
    value.status = "passed";
    assertPackageRecoveryEvidence(value);
  } else {
    throw new Error(`Unknown package activation fixture command: ${command}`);
  }
  save();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
