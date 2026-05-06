#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE_GLOBS = ["src", "test", "packages", "extensions", "scripts"];
const TEST_FILE_PATTERN =
  /(?:\.test(?:-[^./]+)?|\.test-helpers|\.test-harness|\.test-support)\.ts$/u;
const MKDTEMP_PATTERN = /\bmkdtemp(?:Sync)?\s*\(/u;
const CLEANUP_CALL_PATTERN = /\brm(?:Sync)?\s*\(/u;
const AFTER_EACH_PATTERN = /\bafterEach\s*\(/u;
const AFTER_ALL_PATTERN = /\bafterAll\s*\(/u;
const FINALLY_PATTERN = /\bfinally\s*\{/u;

function listTrackedTestFiles(root = repoRoot) {
  const stdout = execFileSync("git", ["-C", root, "ls-files", "--", ...TEST_FILE_GLOBS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((relativePath) => TEST_FILE_PATTERN.test(relativePath))
    .toSorted((left, right) => left.localeCompare(right));
}

function collectCleanupSignals(source) {
  return {
    hasCleanupCall: CLEANUP_CALL_PATTERN.test(source),
    hasAfterEach: AFTER_EACH_PATTERN.test(source),
    hasAfterAll: AFTER_ALL_PATTERN.test(source),
    hasFinally: FINALLY_PATTERN.test(source),
  };
}

function classifyCleanupRisk(source) {
  if (!MKDTEMP_PATTERN.test(source)) {
    return null;
  }
  const cleanup = collectCleanupSignals(source);
  if (
    cleanup.hasCleanupCall &&
    (cleanup.hasAfterEach || cleanup.hasAfterAll || cleanup.hasFinally)
  ) {
    return null;
  }
  return {
    severity: cleanup.hasCleanupCall ? "warning" : "error",
    reason: cleanup.hasCleanupCall
      ? "uses mkdtemp without file-level afterEach/afterAll/finally cleanup scope"
      : "uses mkdtemp without any obvious cleanup",
    cleanup,
  };
}

export async function collectTestTempCleanupFindings(root = repoRoot) {
  const findings = [];
  for (const relativePath of listTrackedTestFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    const source = await fs.readFile(absolutePath, "utf8");
    const risk = classifyCleanupRisk(source);
    if (!risk) {
      continue;
    }
    findings.push({
      file: relativePath,
      ...risk,
    });
  }
  return findings;
}

export async function main(argv = process.argv.slice(2), io) {
  const json = argv.includes("--json");
  const findings = await collectTestTempCleanupFindings(repoRoot);
  const writeStdout = (chunk) => {
    if (io?.stdout?.write) {
      io.stdout.write(chunk);
      return;
    }
    process.stdout.write(chunk);
  };
  const writeStderr = (chunk) => {
    if (io?.stderr?.write) {
      io.stderr.write(chunk);
      return;
    }
    process.stderr.write(chunk);
  };

  if (json) {
    writeStdout(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length > 0) {
    writeStderr("Test temp-dir cleanup findings:\n");
    for (const finding of findings) {
      const severity = finding.severity === "error" ? "error" : "warn";
      writeStderr(`- [${severity}] ${finding.file}: ${finding.reason}\n`);
    }
    writeStderr(
      "Use afterEach/afterAll or try/finally around mkdtemp-created directories so /tmp residue does not leak across runs.\n",
    );
  }

  return findings.some((finding) => finding.severity === "error") ? 1 : 0;
}

runAsScript(import.meta.url, async (argv, io) => {
  const exitCode = await main(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
});
