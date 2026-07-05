// Real behavior proof: malformed `npm view --json` output does not crash update-check.
// fetchNpmPackageTargetStatus already bounds the stdout size; this proof checks that
// a well-formed exit code with malformed JSON is caught and reported instead of
// propagating a raw SyntaxError.

import { fetchNpmPackageTargetStatus } from "../../src/infra/update-check.js";
import type { runCommandWithTimeout } from "../../src/process/exec.js";

const runCommand = async () => ({
  stdout: "not valid json {",
  stderr: "",
  code: 0,
});

console.log("=== Proof: update-check malformed npm view JSON ===\n");
console.log("Simulating npm view with exit code 0 and invalid JSON stdout...\n");

const result = await fetchNpmPackageTargetStatus({
  target: "openclaw",
  timeoutMs: 1000,
  runCommand: runCommand as unknown as typeof runCommandWithTimeout,
});

console.log(`Result: ${JSON.stringify(result, null, 2)}`);

if (result.version === null && result.nodeEngine === null && result.error?.match(/invalid JSON/i)) {
  console.log("\nPASS: malformed npm view JSON is caught and surfaced as an error.");
} else {
  console.log("\nFAIL: expected invalid JSON error with null version/nodeEngine.");
  process.exitCode = 1;
}
