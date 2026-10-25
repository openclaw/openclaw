#!/usr/bin/env node
// The browser proof borrows the public build; private-QA runtime builds stay separate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function verifyRevision(root, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/u, "Expected an exact checkout SHA");
  const info = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  assert.equal(info.commit, revision, "Browser test runtime must match the selected checkout");
  fs.accessSync(path.join(root, "dist/extensions/browser/native-host-entry.js"));
}

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function packBrowserRuntime(root, directory, revision) {
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
  const archive = path.join(directory, "runtime.tar.zst");
  // Preserve hidden build stamps and executable modes; dependencies remain runner-local.
  execFileSync("tar", ["--zstd", "-cf", archive, ...entries.toSorted()], {
    cwd: root,
    stdio: "inherit",
  });
  return digest(archive);
}

export function restoreBrowserRuntime(root, directory, revision, expectedDigest) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/u, "Expected the producer's archive digest");
  const archive = path.join(directory, "runtime.tar.zst");
  assert.equal(digest(archive), expectedDigest, "Browser runtime archive changed in transit");
  execFileSync("tar", ["--zstd", "-xf", archive], { cwd: root, stdio: "inherit" });
  verifyRevision(root, revision);
}

if (import.meta.main) {
  const [operation, target, revision, expectedDigest, ...extra] = process.argv.slice(2);
  assert.ok(
    target &&
      revision &&
      extra.length === 0 &&
      ((operation === "pack" && expectedDigest === undefined) ||
        (operation === "restore" && expectedDigest)),
    "Usage: ui-browser-runtime-artifact.mjs <pack|restore> <directory> <SHA> [digest]",
  );
  const root = process.cwd();
  const directory = path.resolve(target);
  if (operation === "pack") {
    process.stdout.write(`${packBrowserRuntime(root, directory, revision)}\n`);
  } else {
    restoreBrowserRuntime(root, directory, revision, expectedDigest);
  }
}
