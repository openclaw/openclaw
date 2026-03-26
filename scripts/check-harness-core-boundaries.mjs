#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runAsScript, toLine } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HARNESS_CORE_FILES = [
  "src/agents/task-profile.ts",
  "src/agents/task-profile-tool-pack.ts",
  "src/agents/task-profile-skill-pack.ts",
  "src/agents/dynamic-tool-pruning.ts",
  "src/agents/dynamic-skill-pruning.ts",
  "src/agents/verify-report.ts",
  "src/agents/failure-report.ts",
  "src/agents/retry-report.ts",
  "src/agents/delegation-profile.ts",
  "src/agents/failure-rule-suggestions.ts",
  "src/agents/policy-writeback.ts",
  "src/agents/cron-health-checks.ts",
  "src/agents/cron-health-check-install.ts",
  "src/agents/system-prompt-report.ts",
];

const BANNED_IMPORT_ROOTS = [
  path.join(repoRoot, "src", "auto-reply"),
  path.join(repoRoot, "src", "cli", "program"),
  path.join(repoRoot, "src", "commands"),
  path.join(repoRoot, "src", "channels"),
];

const MAX_HARNESS_CORE_LINES = 240;
const KEBAB_CASE_TS_BASENAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

function normalizeResolvedImportPath(candidate) {
  const tries = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, "index.ts"),
    path.join(candidate, "index.tsx"),
    candidate.replace(/\.js$/i, ".ts"),
    candidate.replace(/\.mjs$/i, ".ts"),
  ];
  return tries.map((entry) => path.normalize(entry));
}

function resolveImportPath(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  return normalizeResolvedImportPath(base);
}

function collectImportNodes(sourceFile) {
  const nodes = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      nodes.push({ node: node.moduleSpecifier, specifier: node.moduleSpecifier.text });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      nodes.push({ node: node.moduleSpecifier, specifier: node.moduleSpecifier.text });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      nodes.push({ node: node.arguments[0], specifier: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

function matchBannedRoot(resolvedCandidates) {
  for (const candidate of resolvedCandidates) {
    for (const root of BANNED_IMPORT_ROOTS) {
      if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
        return root;
      }
    }
  }
  return null;
}

export function findHarnessCoreBoundaryViolations(content, filePath) {
  const violations = [];
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const relativeFile = path.relative(repoRoot, filePath);

  const basename = path.basename(filePath);
  if (!KEBAB_CASE_TS_BASENAME_RE.test(basename)) {
    violations.push({
      file: relativeFile,
      line: 1,
      kind: "naming",
      reason: `harness core file must use kebab-case .ts naming: ${basename}`,
      remediation:
        "Rename harness core files to lowercase kebab-case so architecture guardrails stay easy to scan.",
    });
  }

  const lineCount = content.split("\n").length;
  if (lineCount > MAX_HARNESS_CORE_LINES) {
    violations.push({
      file: relativeFile,
      line: 1,
      kind: "file-size",
      reason: `harness core file is ${lineCount} lines (max ${MAX_HARNESS_CORE_LINES})`,
      remediation:
        "Split harness core logic into smaller helpers so policy/verify/report modules stay focused and easy to review.",
    });
  }

  for (const entry of collectImportNodes(sourceFile)) {
    const resolved = resolveImportPath(filePath, entry.specifier);
    if (!resolved) {
      continue;
    }
    const bannedRoot = matchBannedRoot(resolved);
    if (!bannedRoot) {
      continue;
    }
    violations.push({
      file: relativeFile,
      line: toLine(sourceFile, entry.node),
      kind: "import-boundary",
      reason: `imports higher-layer module "${entry.specifier}" from ${path.relative(repoRoot, bannedRoot)}`,
      remediation:
        "Keep harness core modules independent from UI/command/channel layers; move reusable logic into src/agents, src/config, src/infra, src/gateway, or src/utils.",
    });
  }

  return violations;
}

export async function collectHarnessCoreBoundaryViolations() {
  const violations = [];
  for (const relativePath of HARNESS_CORE_FILES) {
    const absPath = path.join(repoRoot, relativePath);
    const content = await fs.readFile(absPath, "utf8");
    violations.push(...findHarnessCoreBoundaryViolations(content, absPath));
  }
  return violations.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.reason.localeCompare(right.reason),
  );
}

export async function main(argv = process.argv.slice(2), io = process) {
  const json = argv.includes("--json");
  const violations = await collectHarnessCoreBoundaryViolations();
  if (violations.length === 0) {
    io.stdout.write(json ? "[]\n" : "harness-core-boundaries: OK\n");
    return 0;
  }

  if (json) {
    io.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
  } else {
    io.stderr.write("harness-core-boundaries: found violations:\n");
    for (const violation of violations) {
      io.stderr.write(
        `- ${violation.file}:${violation.line} [${violation.kind}] ${violation.reason}\n  Fix: ${violation.remediation}\n`,
      );
    }
  }
  return 1;
}

runAsScript(import.meta.url, async () => {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
});
