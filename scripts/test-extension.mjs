#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listAvailableExtensionIds, listChangedExtensionIds } from "./lib/changed-extensions.mjs";
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
  console.error("       node scripts/test-extension.mjs --list");
  console.error(
    "       node scripts/test-extension.mjs --list-changed --base <git-ref> [--head <git-ref>]",
  );
  console.error("       node scripts/test-extension.mjs <extension> --require-tests");
}

function printNoTestsMessage(plan, requireTests) {
  const message = `No tests found for ${plan.extensionDir}. Run "pnpm test:extension ${plan.extensionId} -- --dry-run" to inspect the resolved roots.`;
  if (requireTests) {
    console.error(message);
    return 1;
  }
  console.log(`[test-extension] ${message} Skipping.`);
  return 0;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const requireTests =
    rawArgs.includes("--require-tests") ||
    process.env.OPENCLAW_TEST_EXTENSION_REQUIRE_TESTS === "1";
  const json = rawArgs.includes("--json");
  const list = rawArgs.includes("--list");
  const listChanged = rawArgs.includes("--list-changed");
  const args = rawArgs.filter(
    (arg) =>
      arg !== "--" &&
      arg !== "--dry-run" &&
      arg !== "--require-tests" &&
      arg !== "--json" &&
      arg !== "--list" &&
      arg !== "--list-changed",
  );

  let base = "";
  let head = "HEAD";
  const passthroughArgs = [];

  if (listChanged) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--base") {
        base = args[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (arg === "--head") {
        head = args[index + 1] ?? "HEAD";
        index += 1;
        continue;
      }
      passthroughArgs.push(arg);
    }
  } else {
    passthroughArgs.push(...args);
  }

  if (list) {
    const extensionIds = listAvailableExtensionIds();
    if (json) {
      process.stdout.write(`${JSON.stringify({ extensionIds }, null, 2)}\n`);
    } else {
      for (const extensionId of extensionIds) {
        console.log(extensionId);
      }
    }
    return;
  }

  if (listChanged) {
    let extensionIds;
    try {
      extensionIds = listChangedExtensionIds({ base, head });
    } catch (error) {
      printUsage();
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ base, head, extensionIds }, null, 2)}\n`);
    } else {
      for (const extensionId of extensionIds) {
        console.log(extensionId);
      }
    }
    return;
  }

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

  if (dryRun) {
    if (json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      console.log(`[test-extension] ${plan.extensionId}`);
      console.log(`config: ${plan.config}`);
      console.log(`roots: ${plan.roots.join(", ")}`);
      console.log(`tests: ${plan.testFileCount}`);
    }
    return;
  }

  if (!plan.hasTests) {
    process.exit(printNoTestsMessage(plan, requireTests));
  }

  console.log(
    `[test-extension] Running ${plan.testFileCount} test files for ${plan.extensionId} with ${plan.config}`,
  );
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
