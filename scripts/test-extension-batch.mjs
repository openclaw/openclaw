#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExtensionBatchPlan } from "./lib/extension-test-plan.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pnpm = "pnpm";

async function runVitestBatch(params) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      pnpm,
      ["exec", "vitest", "run", "--config", params.config, ...params.targets, ...params.args],
      {
        cwd: repoRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: params.env,
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

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

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  await run();
}
