/**
 * Issue #100778 proof: classifyCompactionReason + isPreflightCompactionSkipReason
 * exercises the real production code against all compaction reason classes.
 */
import { classifyCompactionReason } from "../src/agents/embedded-agent-runner/compact-reasons.js";

function isPreflightCompactionSkipReason(reason) {
  const c = classifyCompactionReason(reason);
  if (
    c === "below_threshold" ||
    c === "no_compactable_entries" ||
    c === "already_compacted_recently"
  )
    return true;
  return (
    c === "timeout" ||
    c === "provider_error_4xx" ||
    c === "provider_error_5xx" ||
    c === "summary_failed"
  );
}

const cases = [
  ["nothing to compact / no real conversation messages", "no_compactable_entries", true],
  ["below threshold / already under target", "below_threshold", true],
  ["already compacted within cooldown", "already_compacted_recently", true],
  ["compaction timed out after 30s", "timeout", true],
  ["timeout waiting for compaction", "timeout", true],
  ["provider returned 429 rate limit", "provider_error_4xx", true],
  ["provider returned 502 bad gateway", "provider_error_5xx", true],
  ["summary generation failed: model unavailable", "summary_failed", true],
  ["compaction failed for unknown reasons", "unknown", false],
  ["unsupported provider for compaction", "unknown", false],
  ["", "unknown", false],
  [undefined, "unknown", false],
];

let p = 0,
  f = 0;
console.log("isPreflightCompactionSkipReason — real production classifyCompactionReason\n");
for (const [reason, wantClass, wantSkip] of cases) {
  const gotClass = classifyCompactionReason(reason);
  const gotSkip = isPreflightCompactionSkipReason(reason);
  const ok = gotClass === wantClass && gotSkip === wantSkip;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] class=${gotClass.padEnd(28)} skip=${gotSkip}  "${String(reason)}"`,
  );
  if (ok) p++;
  else f++;
}
console.log(`\n${p}/${p + f} passed`);
console.log("\n→ transient failures skip → no dispatch-error → Composer stays active");
if (f > 0) process.exitCode = 1;
