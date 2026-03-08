#!/usr/bin/env node
/**
 * Workflow Chain Debug Script
 *
 * Usage:
 *   bun scripts/debug-workflow-chain.ts <job-id>
 *   bun scripts/debug-workflow-chain.ts --file ~/.openclaw/cron/jobs.json
 */

import fs from "node:fs";

const WF_CHAIN_PREFIX = "__wf_chain__:";

function parseWorkflowChain(description: string) {
  const chainStart = description.indexOf(WF_CHAIN_PREFIX);
  if (chainStart === -1) {
    return null;
  }

  const chainJson = description.slice(chainStart + WF_CHAIN_PREFIX.length);

  try {
    const chain = JSON.parse(chainJson);
    return { chain, chainJson };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      chainJson,
    };
  }
}

function formatStep(step: unknown, idx: number) {
  return `
  ┌─ Step ${idx + 1} ──────────────────────────────────────┐
  │ Node ID:    ${step.nodeId || "N/A"}
  │ Action:     ${step.actionType || "unknown"}
  │ Label:      ${step.label || "N/A"}
  │ Agent ID:   ${step.agentId || "(default)"}
  │ Prompt:     ${(step.prompt || "").substring(0, 80)}${(step.prompt || "").length > 80 ? "..." : ""}
  │ Body:       ${(step.body || "").substring(0, 80)}${(step.body || "").length > 80 ? "..." : ""}
  └─────────────────────────────────────────────────────────┘`;
}

function main() {
  const args = process.argv.slice(2);

  // Find jobs.json
  let jobsPath = "~/.openclaw/cron/jobs.json".replace("~", process.env.HOME || "");

  const fileArg = args.findIndex((a) => a === "--file");
  if (fileArg !== -1 && args[fileArg + 1]) {
    jobsPath = args[fileArg + 1].replace("~", process.env.HOME || "");
  }

  console.log("🔍 Workflow Chain Debug Tool");
  console.log("═══════════════════════════════════════════════════");
  console.log(`📁 Reading from: ${jobsPath}\n`);

  if (!fs.existsSync(jobsPath)) {
    console.error(`❌ File not found: ${jobsPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(jobsPath, "utf-8");
  const data = JSON.parse(content);
  const jobs = data.jobs || [];

  console.log(`📊 Found ${jobs.length} cron job(s)\n`);

  // Filter by job ID if provided
  const jobIdArg = args.find((a) => !a.startsWith("--"));
  const jobsToCheck = jobIdArg
    ? jobs.filter(
        (j: { id?: string; name?: string }) => j.id === jobIdArg || j.name?.includes(jobIdArg),
      )
    : jobs;

  if (jobsToCheck.length === 0) {
    console.log(`⚠️  No jobs found matching: ${jobIdArg || "(all)"}`);
    process.exit(0);
  }

  for (const job of jobsToCheck) {
    console.log("═══════════════════════════════════════════════════");
    console.log(`📋 Job: ${job.name}`);
    console.log(`   ID: ${job.id}`);
    console.log(`   Enabled: ${job.enabled ? "✅" : "❌"}`);
    console.log(`   Schedule: ${job.schedule?.expr || "N/A"}`);
    console.log(
      `   Next Run: ${job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : "N/A"}`,
    );
    console.log(`   Payload: ${JSON.stringify(job.payload)}`);

    const desc = job.description || "";
    console.log(`   Description: ${desc.substring(0, 150)}${desc.length > 150 ? "..." : ""}`);

    const result = parseWorkflowChain(desc);

    if (!result) {
      console.log(`   ⚠️  No workflow chain found\n`);
    } else if ("error" in result) {
      console.log(`   ❌ Failed to parse chain:`);
      console.log(`      Error: ${result.error}`);
      console.log(`      JSON: ${result.chainJson.substring(0, 200)}...\n`);
    } else {
      const { chain } = result;
      console.log(`   ✅ Workflow chain found: ${chain.length} step(s)\n`);

      for (let i = 0; i < chain.length; i++) {
        console.log(formatStep(chain[i], i));
      }

      console.log("\n   🔗 Chain execution flow:");
      for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        const arrow = i < chain.length - 1 ? "↓" : "→ [END]";
        console.log(`      ${i + 1}. ${step.actionType || step.label} ${arrow}`);
        if (step.prompt?.includes("{{input}}")) {
          console.log(`         ⚡ Uses template: {{input}} will be replaced with previous output`);
        }
      }
      console.log();
    }
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("✅ Debug complete");
}

main();
