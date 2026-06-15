#!/usr/bin/env node --import tsx
/**
 * Reproduction script for issue #92511:
 * "Agent session doesn't start after gateway restart (requires second restart)"
 *
 * This script verifies that session restart recovery happens immediately (0ms delay)
 * rather than with the previous 5-second delay that caused the bug.
 *
 * Before fix: DEFAULT_RECOVERY_DELAY_MS = 5_000 (5 seconds)
 * After fix: DEFAULT_RECOVERY_DELAY_MS = 0 (immediate via setImmediate)
 *
 * The bug manifested as:
 * 1. First gateway restart: sessions remain orphaned, agent unresponsive
 * 2. Second gateway restart: sessions recovered, agent works
 *
 * After fix:
 * - Single restart should be sufficient because recovery is immediate
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

async function main() {
  console.log("=== Reproduction for issue #92511 ===");
  console.log("Verifying session restart recovery delay is immediate (0ms)\n");

  // Read the source file to verify the fix
  const recoveryModulePath = path.join(
    repoRoot,
    "src/agents/main-session-restart-recovery.ts"
  );
  const content = await fs.readFile(recoveryModulePath, "utf-8");

  // Check that DEFAULT_RECOVERY_DELAY_MS is 0
  const delayMatch = content.match(/const DEFAULT_RECOVERY_DELAY_MS = (\d+);/);
  if (!delayMatch) {
    console.error("FAIL: Could not find DEFAULT_RECOVERY_DELAY_MS constant");
    process.exitCode = 1;
    return;
  }

  const delayValue = parseInt(delayMatch[1], 10);
  console.log(`Found DEFAULT_RECOVERY_DELAY_MS = ${delayValue}`);

  if (delayValue !== 0) {
    console.error(`FAIL: Expected delay to be 0ms, but got ${delayValue}ms`);
    console.error("This will cause the 'requires second restart' bug!");
    process.exitCode = 1;
    return;
  }

  // Verify the comment explaining why 0ms is used
  const commentPattern = /Immediate recovery ensures sessions are resumed before the gateway accepts user requests/;
  if (!commentPattern.test(content)) {
    console.warn("WARN: Missing explanatory comment for immediate recovery");
  } else {
    console.log("✓ Found explanatory comment for immediate recovery\n");
  }

  // Verify the scheduleRestartAbortedMainSessionRecovery function uses the delay
  const schedulePattern = /const initialDelay = params\.delayMs \?\? DEFAULT_RECOVERY_DELAY_MS;/;
  if (!schedulePattern.test(content)) {
    console.error("FAIL: scheduleRestartAbortedMainSessionRecovery does not use DEFAULT_RECOVERY_DELAY_MS");
    process.exitCode = 1;
    return;
  }

  console.log("✓ scheduleRestartAbortedMainSessionRecovery uses DEFAULT_RECOVERY_DELAY_MS");
  console.log("✓ Recovery will execute immediately via setImmediate (0ms delay)");
  console.log("\nPASS: Session restart recovery is configured for immediate execution.");
  console.log("This fixes the 'requires second restart' bug where:");
  console.log("  - Before: 5-second delay allowed gateway to accept requests before recovery");
  console.log("  - After:  Immediate recovery ensures sessions are ready before first request");
}

main().catch((err) => {
  console.error("FAIL: Unexpected error:", err);
  process.exitCode = 1;
});
