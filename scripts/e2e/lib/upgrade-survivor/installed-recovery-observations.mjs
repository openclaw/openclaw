import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = (file) => sha256(fs.readFileSync(file));
export const fileIdentity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

// Only the scheduler's setgid evidence tree shares reads with the host. The
// private outer directory remains host-only; package/config modes are unrelated.
export function installedRecoveryEvidenceMode(directory, isDirectory = false) {
  const parent = fs.lstatSync(directory);
  assert(parent.isDirectory(), "Evidence parent must be a physical directory");
  const mode = parent.mode & 0o7777;
  const shared = mode === 0o2770 || mode === 0o2750;
  return shared ? (isDirectory ? 0o2750 : 0o640) : isDirectory ? 0o700 : 0o600;
}

export function openInstalledRecoveryEvidence(file) {
  const mode = installedRecoveryEvidenceMode(path.dirname(file));
  const fd = fs.openSync(file, "wx", mode);
  try {
    fs.fchmodSync(fd, mode); // Creation umask must not remove the host's read access.
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

export function startInstalledRecoveryRun(artifacts, cut) {
  const summary = path.join(artifacts, "installed-recovery.json");
  // Invalidate an earlier PASS before install or helper preparation can fail.
  // Keep prior attempt files separate; only this current pointer is replaced.
  writeInstalledRecoveryEvidence(summary, { status: "running" });
  const directory = fs.mkdtempSync(path.join(artifacts, "installed-recovery-"));
  fs.chmodSync(directory, installedRecoveryEvidenceMode(artifacts, true));
  writeInstalledRecoveryEvidence(summary, {
    status: "running",
    runDirectory: path.basename(directory),
    selectedCuts: [cut],
  });
  return { directory, summary };
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
    // Current full-fingerprint publication clears exactly group/other write access.
    // It keeps read/execute, so a non-root service can still run a root-owned install.
    // A writable fixture must not silently accept failed, partial, or excess tightening.
    const mode = tightenPermissions && prior.kind !== "link" ? prior.mode & 0o7755 : prior.mode;
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
