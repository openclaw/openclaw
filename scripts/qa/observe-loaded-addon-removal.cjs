"use strict";

// Standalone mechanism experiment, not installed-upgrade qualification.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

async function main() {
  const [mode, source] = process.argv.slice(2);
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  assert.ok(mode === "loaded" || mode === "unloaded");
  const bytes = await fs.readFile(source);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-loaded-addon-mechanism-"));
  const addon = path.join(root, "koffi.node");
  // The external maintained command owner must remove this root after child exit.
  process.stdout.write(JSON.stringify({ event: "created", mode, root, sha256 }) + "\n");
  await fs.writeFile(addon, bytes, { flag: "wx" });
  const canonicalAddon = await fs.realpath(addon);
  if (mode === "loaded") {
    require(canonicalAddon);
  }
  const normalize = (value) => path.toNamespacedPath(path.resolve(value)).toLowerCase();
  const sharedObjects = process.report.getReport().sharedObjects;
  const addonModulePaths = sharedObjects.filter(
    (value) => path.basename(value).toLowerCase() === "koffi.node",
  );
  assert.ok(addonModulePaths.length <= 4, "Unexpected addon module count");
  const modulePath = addonModulePaths.find(
    (value) => normalize(value) === normalize(canonicalAddon),
  );
  const modulePresent = modulePath !== undefined;
  assert.equal(
    modulePresent,
    mode === "loaded",
    JSON.stringify({ canonicalAddon, addonModulePaths }),
  );
  const started = performance.now();
  let removalError;
  try {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    removalError = { name: error.name, code: error.code, syscall: error.syscall, path: error.path };
  }
  const elapsedMs = performance.now() - started;
  let remaining = [];
  try {
    remaining = await fs.readdir(root);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  process.stdout.write(
    JSON.stringify({
      event: "result",
      mode,
      root,
      sha256,
      node: process.version,
      modulePresent,
      modulePath,
      elapsedMs,
      removalError,
      remaining,
      interpretation: "Mechanism only; does not identify the recorded updater operation",
    }) + "\n",
  );
  if (mode === "unloaded") {
    assert.equal(removalError, undefined);
    assert.deepEqual(remaining, []);
  }
}

main().catch((/** @type {unknown} */ error) => {
  const failure =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          code: "code" in error && typeof error.code === "string" ? error.code : undefined,
        }
      : { name: "Error", message: String(error) };
  process.stderr.write(JSON.stringify(failure) + "\n");
  process.exitCode = 1;
});
