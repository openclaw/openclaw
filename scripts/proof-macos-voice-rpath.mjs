// One-off, secretless release-recovery proof for macos-voice-rpath-45095807853.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const base = "839e86891ff7aeca1495fc633b981db8a3b9707e";
const operation = "macos-voice-rpath-45095807853";
assert.equal(process.platform, "darwin", "Native macOS proof is required");
assert.equal(process.env.GITHUB_REPOSITORY, "openclaw/openclaw");
assert.equal(process.env.GITHUB_REF, "refs/heads/openclaw/macos-voice-proof-45095807853");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const candidate = git("rev-parse", "HEAD");
assert.equal(candidate, process.env.GITHUB_SHA);
git("merge-base", "--is-ancestor", base, candidate);
const root = path.resolve(".openclaw/tmp", operation);
fs.mkdirSync(root, { recursive: true });
const owner = "scripts/lib/desktop-runtime-plugins.mjs";
const candidateOwner = fs.readFileSync(owner);
const baselineOwner = execFileSync("git", ["show", base + ":" + owner]);
const audit = "scripts/lib/mac-runtime-portability.mjs";
assert.deepEqual(fs.readFileSync(audit), execFileSync("git", ["show", base + ":" + audit]));
console.log(JSON.stringify({ operation, base, candidate, runner: process.arch }));

// The expanded regression must fail at the portability boundary, not setup.
const redReport = path.join(root, "red.json");
let red;
try {
  fs.writeFileSync(owner, baselineOwner);
  red = spawnSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "test/scripts/desktop-runtime-plugins.test.ts",
      "--maxWorkers=1",
      "-t",
      "normalizes only staged",
      "--reporter=json",
      "--outputFile=" + redReport,
    ],
    { stdio: "inherit" },
  );
} finally {
  fs.writeFileSync(owner, candidateOwner);
}
assert.equal(red.status, 1, "Baseline must fail with test assertions");
const report = JSON.parse(fs.readFileSync(redReport, "utf8"));
assert.equal(report.numFailedTests, 2);
const failures = report.testResults
  .flatMap((suite) => suite.assertionResults)
  .filter((test) => test.status === "failed");
assert.equal(failures.length, 2);
for (const failure of failures) {
  assert.match(failure.fullName, /^normalizes only staged (arm64|x64) voice rpaths$/);
  assert.match(
    failure.failureMessages.join("\n"),
    /Nonportable LC_RPATH.*codex-voice-host.runfiles/,
  );
}
console.log("RED: both native layouts fail on the exact missing runfiles LC_RPATH");
const greenReport = path.join(root, "green.json");
execFileSync(
  process.execPath,
  [
    "scripts/run-vitest.mjs",
    "run",
    "test/scripts/desktop-runtime-plugins.test.ts",
    "test/scripts/mac-runtime.test.ts",
    "--maxWorkers=1",
    "--reporter=default",
    "--reporter=json",
    "--outputFile=" + greenReport,
  ],
  { stdio: "inherit" },
);
const green = JSON.parse(fs.readFileSync(greenReport, "utf8"));
assert.equal(green.numFailedTests, 0);
const nativeCases = green.testResults
  .flatMap((suite) => suite.assertionResults)
  .filter((test) => /^normalizes only staged (arm64|x64) voice rpaths$/.test(test.fullName));
assert.equal(nativeCases.length, 2);
assert.ok(nativeCases.every((test) => test.status === "passed"));
console.log("GREEN: candidate owner and unchanged portability audit suites passed");

const packages = [
  {
    directory: "codex",
    version: "0.170.0",
    integrity:
      "dwoughgqjiik++CFaNkjQ5y6pJO6LUzu5P1z8Hy4LUeJ+aIYcX/QO1P5rOQnHmBG4agOM7Y+hc4LtVo/a4GFiw==",
  },
  {
    directory: "codex-darwin-x64",
    version: "0.170.0-darwin-x64",
    integrity:
      "lniwntVB9YaCQNNaTgpLxVvABkrnZDCO/UZf3z7POwH71ikkVNi7NxBrfl6aSIS9b3UBJKxjPlAm3qeIxINJVg==",
  },
];
const staged = path.join(root, "staged");
for (const pkg of packages) {
  const url = "https://registry.npmjs.org/@openai/codex/-/codex-" + pkg.version + ".tgz";
  const archive = path.join(root, pkg.directory + ".tgz");
  execFileSync(
    "curl",
    ["--fail", "--location", "--proto", "=https", "--max-time", "300", "--output", archive, url],
    { stdio: "inherit" },
  );
  assert.equal(
    createHash("sha512").update(fs.readFileSync(archive)).digest("base64"),
    pkg.integrity,
  );
  const destination = path.join(staged, "node_modules/@openai", pkg.directory);
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination]);
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  console.log(JSON.stringify({ url, integrity: "sha512-" + pkg.integrity }));
}
// Only the wrapper is a fixture; both Codex packages and all native payloads are real.
// This is a structural x64 package audit, not an x64 execution/voice-session claim.
const plugin = path.join(staged, "dist/extensions/codex");
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(staged, "dist/build-info.json"), JSON.stringify({ commit: candidate }));
fs.writeFileSync(
  path.join(plugin, "package.json"),
  JSON.stringify({ openclaw: { extensions: ["./index.mjs"] } }),
);
fs.writeFileSync(path.join(plugin, "index.mjs"), "export {};\n");
const host = path.join(
  staged,
  "node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/codex-resources/voice/bin/codex-voice-host",
);
const stale =
  "@loader_path/codex-voice-host.runfiles/_main/_solib_darwin_x86_64/voice/native_link_macos_x86_64";
const loadCommands = () => execFileSync("/usr/bin/otool", ["-l", host], { encoding: "utf8" });
assert.ok(
  loadCommands().includes(stale),
  "Published x64 package must reproduce the reported rpath",
);
const { auditMacRuntimePortability } = await import("./lib/mac-runtime-portability.mjs");
const { stampDesktopRuntimePlugins } = await import("./lib/desktop-runtime-plugins.mjs");
assert.throws(() => auditMacRuntimePortability(staged, host), /Nonportable LC_RPATH/);
stampDesktopRuntimePlugins(staged, { commit: candidate, pluginIds: ["codex"] });
assert.ok(!loadCommands().includes(stale));
assert.ok(loadCommands().includes("@loader_path/../lib"));
const nativeFiles = auditMacRuntimePortability(staged, host);
assert.ok(nativeFiles > 1, "Audit must include the complete native payload");
assert.deepEqual(fs.readFileSync(owner), candidateOwner);
assert.deepEqual(fs.readFileSync(audit), execFileSync("git", ["show", base + ":" + audit]));
console.log(
  JSON.stringify({
    operation,
    base,
    candidate,
    nativeFiles,
    result: "real x64 package portable after staging",
  }),
);
