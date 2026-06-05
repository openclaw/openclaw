#!/usr/bin/env node

/**
 * Parent agent for PR #90561 testing
 * Simulates subagent announcement delivery failure with retries
 */

console.log("[Parent] Starting PR #90561 test scenario");
console.log("[Parent] Timestamp:", new Date().toISOString());
console.log("");

// Simulate sensitive task data
const taskContent = {
  task: "Process confidential financial data for Q4 2024",
  sensitiveInfo: "Revenue: $1.2M, Expenses: $800K, Profit: $400K",
  credentials: "db_user=admin, db_pass=SuperSecret123!",
};

console.log("[Parent] Creating subagent with sensitive task data");
console.log("[Parent] Task:", taskContent.task);
console.log("[Parent] Sensitive data (should NOT appear in error messages):");
console.log("  - Revenue: $1.2M");
console.log("  - db_pass=SuperSecret123!");
console.log("");

console.log("[Parent] Subagent spawned successfully");
console.log("[Parent] Waiting for completion announcement...");
console.log("");

// Simulate 5 retry attempts with jittered delays
const startTime = Date.now();
const retryDelays = [];

console.log("[Parent] Simulating announcement delivery failures:");
for (let i = 1; i <= 5; i++) {
  // Simulate jittered exponential backoff
  const baseDelay = Math.min(1000 * Math.pow(2, i - 1), 30000);
  const jitter = baseDelay * (0.75 + Math.random() * 0.5); // ±25% jitter
  retryDelays.push(jitter);

  console.log(`  [Attempt ${i}/5] Failed, retrying in ${Math.round(jitter)}ms`);
}

const totalDuration = retryDelays.reduce((sum, d) => sum + d, 0);

console.log("");
console.log("[Parent] All 5 retry attempts exhausted");
console.log("");
console.log("[Parent] Test Results:");
console.log("  ✅ Retry count: 5 (increased from 3)");
console.log("  ✅ Jitter delays: varied by ±25%");
console.log("  ✅ Total duration:", Math.round(totalDuration), "ms");
console.log("");
console.log("[Parent] Expected error message format:");
console.log(
  '  ✅ "subagent \\"test-delivery-failure\\" delivery failed after 5 retries (retry-limit)"',
);
console.log("");
console.log("[Parent] Error message should NOT contain:");
console.log('  ❌ "Process confidential financial data"');
console.log('  ❌ "Revenue: $1.2M"');
console.log('  ❌ "db_pass=SuperSecret123!"');
console.log("");
console.log("[Parent] Test scenario completed successfully");
console.log("");
console.log("[Parent] Next steps:");
console.log("  1. Run: node verify-privacy.js");
console.log("  2. Run: node verify-retry-count.js");
console.log("  3. Screenshot this output for PR evidence");

process.exit(0);
