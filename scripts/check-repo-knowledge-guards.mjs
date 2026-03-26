#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_FRESHNESS = new Set(["daily", "weekly", "monthly", "quarterly"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEBAB_DOC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const REQUIRED_DOCS = [
  "docs/concepts/docs-index.md",
  "docs/concepts/harness-roadmap.md",
  "docs/zh-CN/concepts/docs-index.md",
  "docs/zh-CN/concepts/harness-engineering-checklist.md",
];

const REQUIRED_FRONTMATTER_FIELDS = ["summary", "owner", "freshness", "last_reviewed", "title"];

function extractFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    return null;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return null;
  }
  return text.slice(4, end);
}

function readScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

async function collectMarkdownFiles(relativeDir) {
  const absDir = path.join(repoRoot, relativeDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(repoRoot, absPath);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(relPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relPath);
    }
  }
  return files;
}

export function findRepoKnowledgeGuardViolations(params) {
  const { file, text } = params;
  const violations = [];
  const frontmatter = extractFrontmatter(text);
  if (!frontmatter) {
    violations.push({
      file,
      reason: "missing YAML frontmatter",
      remediation:
        "Add frontmatter with summary, owner, freshness, last_reviewed, and title so repo knowledge stays machine-checkable.",
    });
    return violations;
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    const value = readScalar(frontmatter, field);
    if (!value) {
      violations.push({
        file,
        reason: `missing frontmatter field "${field}"`,
        remediation:
          "Add the missing frontmatter field so docs index, freshness checks, and ownership linting have a stable contract.",
      });
    }
  }

  const freshness = readScalar(frontmatter, "freshness");
  if (freshness && !ALLOWED_FRESHNESS.has(freshness)) {
    violations.push({
      file,
      reason: `invalid freshness "${freshness}"`,
      remediation: 'Use one of: "daily", "weekly", "monthly", or "quarterly".',
    });
  }

  const lastReviewed = readScalar(frontmatter, "last_reviewed");
  if (lastReviewed && !DATE_RE.test(lastReviewed)) {
    violations.push({
      file,
      reason: `invalid last_reviewed "${lastReviewed}"`,
      remediation: 'Use ISO date format: "YYYY-MM-DD".',
    });
  }

  if (
    (file.startsWith("docs/exec-plans/") || file.startsWith("docs/tech-debt/")) &&
    path.basename(file) !== "README.md" &&
    !KEBAB_DOC_RE.test(path.basename(file))
  ) {
    violations.push({
      file,
      reason: `file name must use lowercase kebab-case: ${path.basename(file)}`,
      remediation:
        "Rename plan and tech-debt docs to lowercase kebab-case so repo knowledge paths remain stable and guessable.",
    });
  }

  return violations;
}

export async function collectRepoKnowledgeGuardViolations() {
  const files = [
    ...REQUIRED_DOCS,
    ...(await collectMarkdownFiles("docs/exec-plans")),
    ...(await collectMarkdownFiles("docs/tech-debt")),
  ];

  const uniqueFiles = [...new Set(files)].toSorted((a, b) => a.localeCompare(b));
  const violations = [];
  for (const file of uniqueFiles) {
    const absPath = path.join(repoRoot, file);
    const text = await fs.readFile(absPath, "utf8");
    violations.push(...findRepoKnowledgeGuardViolations({ file, text }));
  }

  const docsIndex = await fs.readFile(path.join(repoRoot, "docs/concepts/docs-index.md"), "utf8");
  for (const requiredLink of [
    "/exec-plans/README",
    "/tech-debt/README",
    "/concepts/harness-roadmap",
  ]) {
    if (!docsIndex.includes(requiredLink)) {
      violations.push({
        file: "docs/concepts/docs-index.md",
        reason: `missing required docs index link ${requiredLink}`,
        remediation:
          "Keep docs-index.md as the top-level repo knowledge entrypoint by linking roadmap, execution plans, and tech debt ledgers.",
      });
    }
  }

  return violations.toSorted(
    (left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason),
  );
}

export async function main(argv = process.argv.slice(2), io = process) {
  const json = argv.includes("--json");
  const violations = await collectRepoKnowledgeGuardViolations();
  if (violations.length === 0) {
    io.stdout.write(json ? "[]\n" : "repo-knowledge-guards: OK\n");
    return 0;
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
  } else {
    io.stderr.write("repo-knowledge-guards: found violations:\n");
    for (const violation of violations) {
      io.stderr.write(
        `- ${violation.file}: ${violation.reason}\n  Fix: ${violation.remediation}\n`,
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
