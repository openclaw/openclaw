// Real behavior proof for #87876: verifies the existing timeout classifier
// already matches "This operation was aborted" stream abort errors,
// so the configured fallback chain rotates for Bedrock Converse drops.
//
// Run: node --import tsx scripts/repro/issue-87876-stream-abort-classify.mts
import { isTimeoutErrorMessage } from "../../src/agents/embedded-agent-helpers/failover-matches.ts";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// The exact error message from the issue: Bedrock Converse stream drops after ~6 min.
const bedrockAbort = "This operation was aborted";
if (!isTimeoutErrorMessage(bedrockAbort)) {
  fail(`expected "${bedrockAbort}" to be classified as timeout`);
}
console.log(`PASS: "${bedrockAbort}" -> isTimeout=true (shared classifier)`);

// Case-insensitive.
if (!isTimeoutErrorMessage("this operation was aborted")) {
  fail("expected case-insensitive match");
}
console.log("PASS: case-insensitive match works");

// Embedded in a longer message.
if (!isTimeoutErrorMessage("ConverseStream failed: This operation was aborted at connection drop")) {
  fail("expected embedded match");
}
console.log("PASS: embedded in longer message -> true");

// Negative: unrelated abort messages should NOT match the timeout classifier.
if (isTimeoutErrorMessage("Request was aborted by user")) {
  fail("should not match unrelated abort");
}
console.log("PASS: unrelated abort messages -> false");

console.log("\nALL CHECKS PASSED — stream abort errors are already classified as timeout by the shared classifier.");
