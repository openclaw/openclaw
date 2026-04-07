#!/usr/bin/env node

import { resolveExtensionTestPlan } from "./lib/extension-test-plan.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mjs";

function printUsage() {
  console.error("Usage: pnpm test:extension <extension-name|path> [vitest args...]");
  console.error("       node scripts/test-extension.mjs [extension-name|path] [vitest args...]");
}

function printNoTestsMessage(plan) {
  console.log(`[test-extension] No tests found for ${plan.extensionDir}. Skipping.`);
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const passthroughArgs = rawArgs.filter((arg) => arg !== "--");

  let targetArg;
  if (passthroughArgs[0] && !passthroughArgs[0].startsWith("-")) {
    targetArg = passthroughArgs.shift();
  }

  let plan;
  try {
    plan = resolveExtensionTestPlan({ cwd: process.cwd(), targetArg });
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!plan.hasTests) {
    printNoTestsMessage(plan);
    return;
  }

  console.log(`[test-extension] Running ${plan.testFileCount} test files for ${plan.extensionId}`);
  const exitCode = await runVitestBatch({
    args: passthroughArgs,
    config: plan.config,
    env: process.env,
    targets: plan.roots,
  });
  process.exit(exitCode);
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
