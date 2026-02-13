#!/usr/bin/env bun
/**
 * scripts/scan-trends.ts
 *
 * Trigger the Market Watch (Intel Radar) skill via OpenClaw Agent.
 * Usage: bun scripts/scan-trends.ts
 */

import { $ } from "bun";
import { randomUUID } from "crypto";

const sessionId = randomUUID();
console.log(`📡 Intel Radar: Initiating Trend Scan (Session: ${sessionId})...`);

// Trigger the agent to perform the scan
// We use 'openclaw agent' CLI to spawn a new isolated session
try {
  const task =
    "Execute skill: market-watch. Run Intel Radar Daily Brief and send report to Telegram. Output strictly in Traditional Chinese.";
  // We use --session-id to ensure a fresh context
  await $`openclaw agent --session-id ${sessionId} --message ${task} --thinking low`;
  console.log("✅ Scan task completed.");
} catch (error) {
  console.error("❌ Failed to dispatch task:", error);
  process.exit(1);
}
