// Real behavior proof: malformed `npm view --json` output is caught and reported.
// This script builds a fake `npm` executable on disk, invokes
// fetchNpmPackageTargetStatus with command: <fake-npm-path>, and verifies the
// malformed JSON is surfaced as an error instead of escaping as a raw crash.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchNpmPackageTargetStatus } from "../../src/infra/update-check.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-npm-"));
const fakeNpm = path.join(tmpDir, "npm");

// Fake npm: prints malformed JSON to stdout and exits 0, mimicking a broken
// registry response or npm-side glitch that reaches the CLI unchanged.
await fs.writeFile(
  fakeNpm,
  process.platform === "win32"
    ? '@echo off\necho not valid json {\n'
    : '#!/bin/sh\nprintf "not valid json {"\n',
  "utf8",
);
await fs.chmod(fakeNpm, 0o755);

console.log("=== Proof: update-check malformed npm view JSON ===\n");
console.log(`Using fake npm executable: ${fakeNpm}\n`);

const result = await fetchNpmPackageTargetStatus({
  target: "openclaw",
  timeoutMs: 1000,
  command: fakeNpm,
});

console.log(`Result: ${JSON.stringify(result, null, 2)}`);

// Clean up before asserting so the proof exits cleanly even on failure.
try {
  await fs.rm(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup failures
}

if (result.version === null && result.nodeEngine === null && result.error?.match(/invalid JSON/i)) {
  console.log("\nPASS: malformed npm view JSON is caught and surfaced as an error.");
} else {
  console.log("\nFAIL: expected invalid JSON error with null version/nodeEngine.");
  process.exitCode = 1;
}
