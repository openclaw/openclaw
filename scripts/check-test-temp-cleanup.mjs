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
const MKDTEMP_BINDING_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*mkdtemp(?:Sync)?\s*\(/gu;
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

function collectFileCleanupSignals(source) {
  return {
    hasCleanupCall: CLEANUP_CALL_PATTERN.test(source),
    hasAfterEach: AFTER_EACH_PATTERN.test(source),
    hasAfterAll: AFTER_ALL_PATTERN.test(source),
    hasFinally: FINALLY_PATTERN.test(source),
  };
}

function collectMkdtempBindings(source) {
  return Array.from(source.matchAll(MKDTEMP_BINDING_PATTERN), (match) => match[1]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasCleanupCallForBinding(source, variableName) {
  const escapedVariableName = escapeRegExp(variableName);
  const cleanupPattern = new RegExp(
    String.raw`\brm(?:Sync)?\s*\([^\n;]*\b${escapedVariableName}\b`,
    "u",
  );
  return cleanupPattern.test(source);
}

function classifyCleanupRisk(source) {
  if (!MKDTEMP_PATTERN.test(source)) {
    return null;
  }

  const cleanup = collectFileCleanupSignals(source);
  const hasLifecycleScope = cleanup.hasAfterEach || cleanup.hasAfterAll || cleanup.hasFinally;
  const bindings = collectMkdtempBindings(source).map((variableName) => ({
    variableName,
    hasCleanupCall: hasCleanupCallForBinding(source, variableName),
  }));

  if (bindings.length === 0) {
    return {
      severity: cleanup.hasCleanupCall ? "warning" : "error",
      reason: cleanup.hasCleanupCall
        ? "uses mkdtemp without cleanup tied to a temp-dir binding in afterEach/afterAll/finally scope"
        : "uses mkdtemp without any obvious cleanup",
      cleanup: {
        ...cleanup,
        bindings,
      },
    };
  }

  const unresolvedBindings = bindings.filter(
    (binding) => !binding.hasCleanupCall || !hasLifecycleScope,
  );
  if (unresolvedBindings.length === 0) {
    return null;
  }

  const bindingsMissingCleanup = unresolvedBindings
    .filter((binding) => !binding.hasCleanupCall)
    .map((binding) => binding.variableName);

  return {
    severity: bindingsMissingCleanup.length > 0 ? "error" : "warning",
    reason:
      bindingsMissingCleanup.length > 0
        ? `uses mkdtemp without cleanup for temp-dir binding(s): ${bindingsMissingCleanup.join(", ")}`
        : `uses mkdtemp without file-level afterEach/afterAll/finally cleanup scope for temp-dir binding(s): ${unresolvedBindings
            .map((binding) => binding.variableName)
            .join(", ")}`,
    cleanup: {
      ...cleanup,
      bindings,
    },
  };
}

export async function collectTestTempCleanupFindings(root = repoRoot) {
  const findings = [];
  for (const relativePath of listTrackedTestFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    let source;
    try {
      source = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
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

export async function renderTestTempCleanupReport(params) {
  const findings = await collectTestTempCleanupFindings(params.root ?? repoRoot);
  const writeStdout = (chunk) => {
    if (params.io?.stdout?.write) {
      params.io.stdout.write(chunk);
      return;
    }
    process.stdout.write(chunk);
  };
  const writeStderr = (chunk) => {
    if (params.io?.stderr?.write) {
      params.io.stderr.write(chunk);
      return;
    }
    process.stderr.write(chunk);
  };

  if (params.json) {
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

  return {
    findings,
    exitCode: findings.some((finding) => finding.severity === "error") ? 1 : 0,
  };
}

export async function main(argv = process.argv.slice(2), io) {
  const result = await renderTestTempCleanupReport({
    root: repoRoot,
    json: argv.includes("--json"),
    io,
  });
  return result.exitCode;
}

runAsScript(import.meta.url, async (argv, io) => {
  const exitCode = await main(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
});
