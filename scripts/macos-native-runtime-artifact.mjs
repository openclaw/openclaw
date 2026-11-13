#!/usr/bin/env node
// Reuse the Linux runtime build without transferring platform-specific dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function verifyRevision(root, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/u, "Expected an exact checkout SHA");
  const info = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  assert.equal(info.commit, revision, "Native test runtime must match the selected checkout");
}

// native-runtime-bundled-recovery-v1: selected-source capability for complete build reuse.
export function packNativeRuntime(root, directory, revision, { bundledRecovery = false } = {}) {
  verifyRevision(root, revision);
  const entries = ["dist"];
  if (fs.existsSync(path.join(root, "dist-runtime"))) {
    entries.push("dist-runtime");
  }
  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    const dist = path.join("packages", entry.name, "dist");
    if (entry.isDirectory() && fs.existsSync(path.join(root, dist))) {
      entries.push(dist);
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  // Policy-only jobs omit UI/plugins/deployment output. Recovery packaging needs all of them,
  // including the sealed worker's lock-pinned cross-platform assets, never host node_modules.
  // tar preserves executable bits and relative overlay links.
  execFileSync(
    "tar",
    [
      "-czf",
      path.join(directory, "runtime.tgz"),
      "--exclude=node_modules",
      ...(bundledRecovery
        ? []
        : [
            "--exclude=dist/extensions",
            "--exclude=dist/control-ui",
            "--exclude=dist/worker",
            "--exclude=dist-runtime/extensions",
          ]),
      ...entries.toSorted(),
    ],
    { cwd: root, stdio: "inherit" },
  );
}

export function restoreNativeRuntime(root, directory, revision) {
  execFileSync("tar", ["-xzf", path.join(directory, "runtime.tgz")], {
    cwd: root,
    stdio: "inherit",
  });
  verifyRevision(root, revision);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "openclaw.mjs"))} "$@"\n`,
    { mode: 0o700 },
  );
  return bin;
}

if (import.meta.main) {
  const [operation, target, revision, ...extra] = process.argv.slice(2);
  if (
    !target ||
    !revision ||
    extra.length ||
    !["pack", "pack-recovery", "restore"].includes(operation)
  ) {
    throw new Error(
      "Usage: macos-native-runtime-artifact.mjs <pack|pack-recovery|restore> <directory> <SHA>",
    );
  }
  const root = process.cwd();
  const directory = path.resolve(target);
  if (operation !== "restore") {
    packNativeRuntime(root, directory, revision, {
      bundledRecovery: operation === "pack-recovery",
    });
  } else {
    process.stdout.write(`${restoreNativeRuntime(root, directory, revision)}\n`);
  }
}
