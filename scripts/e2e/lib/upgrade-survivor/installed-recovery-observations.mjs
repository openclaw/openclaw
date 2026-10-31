import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { selectInstalledRecoveryCuts } from "./installed-recovery-cases.mjs";
import { readDatabase } from "./observations.mjs";
export { retirementCuts } from "./installed-recovery-cases.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = (file) => sha256(fs.readFileSync(file));
export const fileIdentity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

export function installedRecoveryEvidenceMode(directory, isDirectory = false) {
  const parent = fs.lstatSync(directory);
  assert(parent.isDirectory(), "Evidence parent must be a physical directory");
  return isDirectory ? 0o700 : 0o600;
}

export function openInstalledRecoveryEvidence(file) {
  const mode = installedRecoveryEvidenceMode(path.dirname(file));
  const fd = fs.openSync(file, "wx", mode);
  try {
    fs.fchmodSync(fd, mode); // Creation umask must not remove the owner's access.
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function writeInstalledRecoveryEvidence(file, value) {
  const temporary = `${file}.tmp`;
  const fd = openInstalledRecoveryEvidence(temporary);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export function startInstalledRecoveryRun(artifacts, cut = "") {
  const selectedCuts =
    cut === "older-runtime" ? [cut] : selectInstalledRecoveryCuts(cut).map(([, value]) => value);
  const summary = path.join(artifacts, "installed-recovery.json");
  // Invalidate an earlier PASS before install or helper preparation can fail.
  // Keep prior attempt files separate; only this current pointer is replaced.
  writeInstalledRecoveryEvidence(summary, { status: "running" });
  const directory = fs.mkdtempSync(path.join(artifacts, "installed-recovery-"));
  fs.chmodSync(directory, installedRecoveryEvidenceMode(artifacts, true));
  writeInstalledRecoveryEvidence(summary, {
    status: "running",
    runDirectory: path.basename(directory),
    selectedCuts,
  });
  return { directory, summary };
}

export function readActivation(journal) {
  return readDatabase(journal, (db) => {
    const rows = db.prepare("SELECT * FROM package_activation").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slot, 1);
    // Node SQLite rows have a null prototype; JSON evidence uses plain objects.
    // Preserve every column while giving strict snapshots one representation.
    return { ...rows[0] };
  });
}

export function assertInstalledRecoveryConfig(original, updated, inspected) {
  const settings = (bytes) => {
    const { gateway, plugins } = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return {
      mode: gateway.mode,
      port: gateway.port,
      bind: gateway.bind,
      reloadMode: gateway.reload?.mode,
      auth: gateway.auth,
      pluginsEnabled: plugins.enabled,
    };
  };
  assert.deepEqual(settings(updated), settings(original), "configured operator settings changed");
  assert.deepEqual(inspected, updated, "status changed full config bytes");
}

// These checkpoints observe direct renames, including in-tree hardlink aliases.
// Keep every entry (even npm caches); never follow links outside the package.
export function capturePackageTree(root, { maxEntries = 100_000, maxBytes = 4 * 1024 ** 3 } = {}) {
  const entries = [];
  const buffer = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  let discoveredEntries = 1;
  const visit = (relative) => {
    assert(entries.length < maxEntries, "Package tree entry budget exceeded");
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    assert(kind !== "file" || stat.isFile(), "Unsupported package entry kind");
    let content = null;
    if (kind === "file") {
      assert(stat.size <= BigInt(maxBytes - bytes), "Package tree byte budget exceeded");
      const hash = createHash("sha256");
      const fd = fs.openSync(file, "r");
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        assert(
          opened.dev === stat.dev && opened.ino === stat.ino,
          "Package file changed before read",
        );
        for (let count; (count = fs.readSync(fd, buffer)) > 0;) {
          bytes += count;
          assert(bytes <= maxBytes, "Package tree byte budget exceeded");
          hash.update(buffer.subarray(0, count));
        }
        const after = fs.fstatSync(fd, { bigint: true });
        assert(
          after.size === stat.size &&
            after.mtimeNs === stat.mtimeNs &&
            after.ctimeNs === stat.ctimeNs,
          "Package file changed during read",
        );
      } finally {
        fs.closeSync(fd);
      }
      content = hash.digest("hex");
    } else if (kind === "link") {
      content = fs.readlinkSync(file);
    }
    entries.push({
      path: relative,
      kind,
      mode: Number(stat.mode & 0o7777n),
      uid: String(stat.uid),
      gid: String(stat.gid),
      identity: `${stat.dev}:${stat.ino}`,
      content,
    });
    if (kind === "directory") {
      const names = [];
      const directory = fs.opendirSync(file);
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          // Reserve pending siblings too, before retaining or sorting their names.
          assert(discoveredEntries < maxEntries, "Package tree entry budget exceeded");
          discoveredEntries++;
          names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      for (const name of names.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        visit(path.join(relative, name));
      }
    }
  };
  visit("");
  return entries;
}

export function assertPackageTree(expected, actual, { tightenPermissions = false } = {}) {
  const before = new Map(expected.map((entry) => [entry.path, entry]));
  const after = new Map(actual.map((entry) => [entry.path, entry]));
  const differences = [];
  let differenceCount = 0;
  const changed = (relative, field) => {
    differenceCount++;
    if (differences.length < 5) {
      differences.push(`${JSON.stringify((relative || ".").slice(0, 96))}: ${field}`);
    }
  };
  for (const relative of [...new Set([...before.keys(), ...after.keys()])].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const prior = before.get(relative);
    const observed = after.get(relative);
    if (!prior || !observed) {
      changed(relative, prior ? "removed" : "added");
      continue;
    }
    for (const field of ["kind", "uid", "gid", "identity", "content"]) {
      if (prior[field] !== observed[field]) {
        changed(relative, field === "content" && prior.kind === "link" ? "link target" : field);
      }
    }
    // Current full-fingerprint publication clears exactly group/other access.
    // A writable fixture must not silently accept failed or partial tightening.
    const mode = tightenPermissions && prior.kind !== "link" ? prior.mode & 0o7700 : prior.mode;
    if (mode !== observed.mode) {
      changed(
        relative,
        `mode ${prior.mode.toString(8)} -> ${observed.mode.toString(8)} (expected ${mode.toString(8)})`,
      );
    }
  }
  assert.equal(
    differenceCount,
    0,
    `Package tree changed: ${differences.join("; ")} (${differenceCount} field differences; ${Math.max(0, differenceCount - differences.length)} more)`,
  );
  return actual;
}

// Decode only quoteCliArg's emitted grammar. This is data, never a shell program:
// no expansion, command substitution, double quotes, or general shell escapes.
export function parseRecoveryCommand(output) {
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Package publication recovery: "));
  assert.equal(lines.length, 1, "expected one printed external recovery command");
  const command = lines[0].slice("Package publication recovery: ".length);
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    let token = "";
    let consumed = false;
    while (index < command.length && command[index] !== " ") {
      consumed = true;
      if (command[index] === "'") {
        const end = command.indexOf("'", index + 1);
        assert(end !== -1, "unterminated recovery argument");
        token += command.slice(index + 1, end);
        index = end + 1;
      } else if (command.slice(index, index + 2) === "\\'") {
        token += "'";
        index += 2;
      } else {
        assert(/[A-Za-z0-9_/:=.,@%+-]/u.test(command[index]), "unexpected recovery command syntax");
        token += command[index++];
      }
    }
    assert(consumed && token.length > 0, "empty recovery argument");
    tokens.push(token);
    if (index < command.length) {
      index++;
      assert(index < command.length && command[index] !== " ", "unexpected recovery spacing");
    }
  }
  assert.equal(tokens.length, 7);
  const [node, helper, anchorFlag, anchor, operationFlag, operation, action] = tokens;
  assert.equal(anchorFlag, "--anchor");
  assert.equal(operationFlag, "--operation");
  assert.equal(action, "status");
  assert.match(operation, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  // The printed command belongs to the Linux container, regardless of test host.
  for (const file of [node, helper, anchor]) {
    assert(path.posix.isAbsolute(file) && path.posix.resolve(file) === file);
  }
  return { node, helper, anchor, operation };
}

export function assertRetirementCut(cut, evidence, anchor, helper) {
  assert.equal(evidence.cut, cut);
  const intent = JSON.parse(evidence.row.intent_json);
  if (cut === "partial-previous") {
    assert.equal(evidence.row.phase, "retiring");
    assert.equal(intent.kind, "remove");
    assert.equal(intent.name, "previous");
    assert.equal(fs.existsSync(evidence.effect), false);
    assert(fs.existsSync(path.join(anchor, "previous")), "cut must leave a partial obsolete tree");
  } else if (cut.startsWith("anchor-")) {
    assert.equal(evidence.row.phase, "retiring");
    assert.equal(intent.kind, "remove-anchor");
    assert.equal(fs.existsSync(anchor), cut === "anchor-before");
  } else {
    assert.equal(evidence.row.phase, "anchor-retired");
    assert.equal(intent.kind, "unlink-helper");
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(fs.existsSync(helper), cut === "helper-before");
  }
  assert.equal(intent.selected, "candidate");
  if (cut.endsWith("-sync")) {
    assert.equal(evidence.synced, true, "cut must follow real directory fsync");
  }
}
