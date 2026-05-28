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
  const closurePath = path.join(repoRoot, "scripts", "openclaw-test-changed-closure.mjs");
  await assertFileExists(closurePath, "test changed closure");
  await assertTextContains(
    closurePath,
    "openclaw.test-changed-closure.report.v1",
    "test changed closure",
  );
  await assertTextContains(closurePath, "ignoreBrokenPipe", "test changed closure");
  await assertTextContains(closurePath, "EPIPE", "test changed closure");
  await assertTextContains(closurePath, "resolveSpawnCommand", "test changed closure");
  await assertTextContains(closurePath, "cmd.exe", "test changed closure");
  await assertTextContains(closurePath, "/d", "test changed closure");

  const packageJson = await readPackageJson(repoRoot);
  assertScriptContains(
    packageJson.scripts,
    "autonomous:test:changed:closure",
    "scripts/openclaw-test-changed-closure.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "check:openclaw-test-changed-closure",
    "scripts/check-openclaw-test-changed-closure.mjs",
  );

  process.stdout.write("OPENCLAW_TEST_CHANGED_CLOSURE_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw test changed closure check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
