#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

async function readPackageJson(repoRoot) {
  const filePath = path.join(repoRoot, "package.json");
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function assertFileExists(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch (error) {
    throw new Error(`${label} missing: ${filePath}`, { cause: error });
  }
}

async function assertTextContains(filePath, expectedToken, label) {
  const content = await fs.readFile(filePath, "utf8");
  if (!content.includes(expectedToken)) {
    throw new Error(`${label} must include ${expectedToken}`);
  }
}

function assertScriptContains(scripts, key, expectedToken) {
  const value = scripts?.[key];
  if (typeof value !== "string" || !value.includes(expectedToken)) {
    throw new Error(`package.json script ${key} must include ${expectedToken}`);
  }
}

async function main() {
  const repoRoot = process.cwd();
  const watchPath = path.join(repoRoot, "scripts", "openclaw-controlled-task-runner-watch.mjs");
  await assertFileExists(watchPath, "controlled task runner watch");
  await assertTextContains(
    watchPath,
    "openclaw-controlled-task-runner-watch-latest.json",
    "controlled task runner watch",
  );
  await assertTextContains(
    watchPath,
    "openclaw-controlled-task-runner-watch-runs.jsonl",
    "controlled task runner watch",
  );
  await assertTextContains(watchPath, "runner_state_changed", "controlled task runner watch");
  await assertTextContains(watchPath, "--run", "controlled task runner watch");
  await assertTextContains(watchPath, "--json", "controlled task runner watch");

  const packageJson = await readPackageJson(repoRoot);
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:watch",
    "scripts/openclaw-controlled-task-runner-watch.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:watch:once",
    "scripts/openclaw-controlled-task-runner-watch.mjs --once --json --task controlled_task_runner_check",
  );
  assertScriptContains(
    packageJson.scripts,
    "check:openclaw-controlled-task-runner-watch",
    "scripts/check-openclaw-controlled-task-runner-watch.mjs",
  );

  process.stdout.write("OPENCLAW_CONTROLLED_TASK_RUNNER_WATCH_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw controlled task runner watch check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
