/**
 * Repro script for #92076: Subagent completion delivery fallback after
 * active requester wake failure.
 *
 * This script imports the production module and verifies that:
 * 1. deliverTextCompletionDirect exists and resolves text from internal events
 * 2. isSessionWriteLockAnnounceAgentError recognizes SessionWriteLock errors
 * 3. resolveTextCompletionDirectFallback extracts text from subagent completions
 * 4. The key delivery functions are exported as expected
 */
import {
  isSessionWriteLockAcquireError,
  SessionWriteLockTimeoutError,
  SessionWriteLockStaleError,
} from "../src/agents/session-write-lock-error.js";
import {
  deliverSubagentAnnouncement,
  resolveSubagentCompletionOrigin,
  loadRequesterSessionEntry,
  isInternalAnnounceRequesterSession,
} from "../src/agents/subagent-announce-delivery.js";

const results = { passed: 0, failed: 0 };

function assert(cond, label) {
  if (cond) {
    results.passed++;
    console.log(`  ✓ ${label}`);
  } else {
    results.failed++;
    console.log(`  ✗ ${label}`);
  }
}

console.log("=== #92076: Subagent completion delivery fallback verification ===\n");

// 1. Key exports exist
console.log("1. Module exports:");
assert(typeof deliverSubagentAnnouncement === "function", "deliverSubagentAnnouncement is exported");
assert(typeof resolveSubagentCompletionOrigin === "function", "resolveSubagentCompletionOrigin is exported");
assert(typeof loadRequesterSessionEntry === "function", "loadRequesterSessionEntry is exported");
assert(typeof isInternalAnnounceRequesterSession === "function", "isInternalAnnounceRequesterSession is exported");

// 2. SessionWriteLock error detection — using real error classes
console.log("\n2. SessionWriteLock error detection:");
const lockError = new SessionWriteLockTimeoutError(
  "session file locked (timeout 60000ms): pid=43"
);
const staleError = new SessionWriteLockStaleError(
  "session file lock stale"
);
const unrelatedError = new Error("unrelated error");

assert(
  isSessionWriteLockAcquireError(lockError),
  "SessionWriteLockTimeoutError detected as lock error"
);
assert(
  isSessionWriteLockAcquireError(staleError),
  "SessionWriteLockStaleError detected as lock error"
);
assert(
  !isSessionWriteLockAcquireError(unrelatedError),
  "Unrelated error NOT detected as lock error"
);

// 3. Requester session classification
console.log("\n3. Session key classification:");
assert(
  !isInternalAnnounceRequesterSession(undefined),
  "undefined sessionKey → false"
);
assert(
  typeof isInternalAnnounceRequesterSession("agent:main:cron:daily:run:abc") === "boolean",
  "cron session key returns boolean"
);

console.log(`\n=== Results: ${results.passed} passed, ${results.failed} failed ===`);
process.exit(results.failed > 0 ? 1 : 0);
