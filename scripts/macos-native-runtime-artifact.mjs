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

export function packNativeRuntime(root, directory, revision) {
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
  // The policy CLI uses core workers, not UI, plugins, or the sealed remote-worker deployment.
  // tar preserves executable bits; native dependencies stay on their target platform.
  execFileSync(
    "tar",
    [
      "-czf",
      path.join(directory, "runtime.tgz"),
      "--exclude=dist/extensions",
      "--exclude=dist/control-ui",
      "--exclude=dist/worker",
      "--exclude=dist-runtime/extensions",
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
  if (!target || !revision || extra.length || !["pack", "restore"].includes(operation)) {
    throw new Error("Usage: macos-native-runtime-artifact.mjs <pack|restore> <directory> <SHA>");
  }
  const root = process.cwd();
  const directory = path.resolve(target);
  if (operation === "pack") {
    packNativeRuntime(root, directory, revision);
  } else {
    process.stdout.write(`${restoreNativeRuntime(root, directory, revision)}\n`);
  }
}
