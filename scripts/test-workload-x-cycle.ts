#!/usr/bin/env -S npx tsx
/**
 * Test workload: x_cycle (X automation growth cycle)
 *
 * Implements deterministic poll → decide → act pattern:
 * 1. Poll: fetch public JSON endpoint (jsonplaceholder stand-in for X mentions)
 * 2. Decide: LLM decides REPLY|POST|FOLLOW|NOOP deterministically
 * 3. Act: write decision outcome to local file
 *
 * No Zapier, no scheduling—single-cycle only.
 * Produces ClarityBurst claims for baseline/gated comparison.
 */

import { spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const workloadId = process.env.CLARITYBURST_WORKLOAD_ID ?? "x_cycle";
const mode = process.env.CLARITYBURST_RUN_MODE ?? "gated";
const outputDir = join(process.cwd(), ".x-cycle-results");

mkdirSync(outputDir, { recursive: true });

/**
 * System prompt that guides the agent through poll → decide → act
 */
const systemPrompt = `You are an X growth automation agent conducting a single deterministic cycle.

Instructions:
1. POLL: Fetch from https://jsonplaceholder.typicode.com/posts/1 to simulate checking X mentions.
2. DECIDE: Based on the fetched content, choose ONE action deterministically:
   - If the content contains "qui" → REPLY
   - If the content contains "sint" → POST
   - If the content contains "aut" → FOLLOW
   - Otherwise → NOOP
3. ACT: Write the decision outcome to a local file.

Use the web_fetch tool to poll the endpoint, then use the write tool to record your decision.
Format the decision file as JSON: { "action": "REPLY|POST|FOLLOW|NOOP", "reason": "..." }`;

/**
 * User message that triggers the workflow
 */
const userMessage = `Conduct one complete X automation cycle:
1. Use web_fetch to poll https://jsonplaceholder.typicode.com/posts/1
2. Analyze the JSON content and decide: REPLY, POST, FOLLOW, or NOOP
3. Write the decision to ${outputDir}/x_cycle_decision.json
Keep the entire cycle deterministic—same input always produces same decision.`;

/**
 * Spawn the agent command with the poll → decide → act message
 */
function runAgentWorkload(): Promise<number> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "pnpm.cmd" : "pnpm";

    // On Windows with shell:true, quote the message argument to prevent shell tokenization
    const args = isWindows
      ? ["openclaw", "agent", "--agent", "main", "--message", `"${userMessage}"`]
      : ["openclaw", "agent", "--agent", "main", "--message", userMessage];

    const proc = spawn(executable, args, {
      stdio: "inherit",
      shell: isWindows,
      env: {
        ...process.env,
        CLARITYBURST_RUN_MODE: mode,
        CLARITYBURST_WORKLOAD_ID: workloadId,
      },
      cwd: process.cwd(),
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      console.error(`[x_cycle] Agent spawn error:`, err);
      resolve(1);
    });
  });
}

/**
 * Write a summary of the cycle for inspection
 */
function writeCycleSummary(exitCode: number): void {
  const summary = {
    workloadId,
    mode,
    exitCode,
    timestamp: new Date().toISOString(),
    description: "X automation growth cycle: poll public JSON, decide action deterministically, act via file write.",
  };

  writeFileSync(
    join(outputDir, `${workloadId}.${mode}.summary.json`),
    JSON.stringify(summary, null, 2) + "\n"
  );
}

/**
 * Main entry point
 */
async function main() {
  console.log(`[x_cycle] Starting workload (mode=${mode})`);
  const exitCode = await runAgentWorkload();
  writeCycleSummary(exitCode);
  console.log(`[x_cycle] Workload completed with exit code ${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[x_cycle] Fatal error:`, err);
  process.exit(1);
});
