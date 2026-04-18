#!/usr/bin/env node

import { resolveExtensionBatchPlan } from "./lib/extension-test-plan.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mjs";

function printUsage() {
  console.error("Usage: pnpm test:extensions:batch <extension[,extension...]> [vitest args...]");
  console.error(
    "       node scripts/test-extension-batch.mjs <extension[,extension...]> [vitest args...]",
  );
}

function parseExtensionIds(rawArgs) {
  const args = [...rawArgs];
  const extensionIds = [];

  while (args[0] && !args[0].startsWith("-")) {
    extensionIds.push(
      ...args
        .shift()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  return { extensionIds, passthroughArgs: args };
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const passthroughArgs = rawArgs.filter((arg) => arg !== "--");
  const { extensionIds, passthroughArgs: vitestArgs } = parseExtensionIds(passthroughArgs);
  if (extensionIds.length === 0) {
    printUsage();
    process.exit(1);
  }

  const batchPlan = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
  if (!batchPlan.hasTests) {
    console.log("[test-extension-batch] No tests found for the requested extensions. Skipping.");
    return;
  }

  console.log(
    `[test-extension-batch] Running ${batchPlan.testFileCount} test files across ${batchPlan.extensionCount} extensions`,
  );

  for (const group of batchPlan.planGroups) {
    console.log(
      `[test-extension-batch] ${group.config}: ${group.extensionIds.join(", ")} (${group.testFileCount} files)`,
    );
    const exitCode = await runVitestBatch({
      args: vitestArgs,
      config: group.config,
      env: process.env,
      targets: group.roots,
    });
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
