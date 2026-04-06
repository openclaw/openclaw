#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExtensionTestPlan } from "./lib/extension-test-plan.mjs";

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

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  await run();
}
