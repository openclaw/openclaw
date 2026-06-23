// Real behavior proof for #87876: verifies the existing timeout classifier
// already matches "This operation was aborted" stream abort errors.
// The full classification chain classifies it as "timeout", meaning the
// configured fallback model is tried instead of surfacing the error.
//
// Run: node --import tsx scripts/repro/issue-87876-stream-abort-classify.mts
import { classifyFailoverReason, isTimeoutErrorMessage } from "../../src/agents/embedded-agent-helpers/errors.ts";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// 1. Shared timeout classifier matches "This operation was aborted"
const bedrockAbort = "This operation was aborted";
if (!isTimeoutErrorMessage(bedrockAbort)) {
  fail(`expected "${bedrockAbort}" to be classified as timeout by shared classifier`);
}
console.log(`PASS: "${bedrockAbort}" -> isTimeout=true (shared classifier)`);

// 2. Full classification chain classifies as "timeout" (triggers fallback rotation)
const reason = classifyFailoverReason(bedrockAbort);
if (reason !== "timeout") {
  fail(`expected classifyFailoverReason to return "timeout", got "${reason}"`);
}
console.log(`PASS: classifyFailoverReason("${bedrockAbort}") = "${reason}" (triggers fallback)`);

// 3. Embedded in a longer provider message
const embedded = classifyFailoverReason("ConverseStream failed: This operation was aborted");
if (embedded !== "timeout") {
  fail(`expected embedded classification to be "timeout", got "${embedded}"`);
}
console.log(`PASS: embedded message -> "${embedded}"`);

console.log("\nALL CHECKS PASSED — stream abort errors are classified as timeout by the shared classifier, triggering fallback rotation.");
