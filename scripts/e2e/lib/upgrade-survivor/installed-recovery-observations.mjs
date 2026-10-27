import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
