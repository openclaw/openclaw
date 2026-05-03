#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    base: "origin/main",
    json: false,
    output: null,
    includeUntracked: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--base") {
      args.base = argv[++i] ?? args.base;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++i] ?? args.output;
    } else if (arg === "--no-untracked") {
      args.includeUntracked = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/jit-diff-test-planner.mjs [options]

Build a change-specific JiT catching-test plan from the current git diff.

Options:
  --base <ref>       Base ref for merge-base diff (default: origin/main)
  --json             Print JSON instead of Markdown
  --output <path>    Write report to a file
  --no-untracked     Ignore untracked files
`);
}

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function splitLines(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFiles(base, includeUntracked) {
  const mergeBase = git(["merge-base", "HEAD", base], "");
  const diffBase = mergeBase || base;
  const files = new Set(splitLines(git(["diff", "--name-only", diffBase], "")));
  for (const file of splitLines(git(["diff", "--name-only", "--cached"], ""))) {
    files.add(file);
  }
  if (includeUntracked) {
    for (const file of splitLines(git(["ls-files", "--others", "--exclude-standard"], ""))) {
      files.add(file);
    }
  }
  return [...files].toSorted((a, b) => a.localeCompare(b));
}

function classify(file) {
  if (/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(file)) {
    return "test";
  }
  if (file.startsWith("docs/") || /\.(md|mdx)$/.test(file)) {
    return "docs";
  }
  if (file.startsWith("scripts/") || /\.(mjs|cjs)$/.test(file)) {
    return "script";
  }
  if (file.startsWith("extensions/")) {
    return "extension";
  }
  if (file.startsWith("ui/")) {
    return "ui";
  }
  if (file.startsWith("src/")) {
    return "core";
  }
  if (/package\.json$|pnpm-lock\.yaml$/.test(file)) {
    return "package";
  }
  return "other";
}

function candidateTestFiles(file, allFiles) {
  const ext = path.extname(file);
  const dir = path.dirname(file);
  const stem = path.basename(file, ext);
  const candidates = [
    path.join(dir, `${stem}.test${ext}`),
    path.join(dir, `${stem}.spec${ext}`),
    path.join(dir, `${stem}.test.ts`),
    path.join(dir, `${stem}.spec.ts`),
  ];
  const direct = candidates.filter((candidate) => allFiles.has(candidate) || existsSync(candidate));
  if (direct.length > 0) {
    return direct;
  }

  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...allFiles]
    .filter((candidate) => /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(candidate))
    .filter(
      (candidate) =>
        candidate.includes(dir) || new RegExp(`${escapedStem}.*\\.(test|spec)\\.`).test(candidate),
    )
    .slice(0, 4);
}

function extractRiskSignals(file) {
  if (!existsSync(file) || !/\.(ts|tsx|js|mjs|cjs)$/.test(file)) {
    return [];
  }
  const text = readFileSync(file, "utf8").slice(0, 80_000);
  const signals = [];
  const checks = [
    [/auth|token|secret|password|apiKey|credential/i, "auth-or-secret handling changed"],
    [/exec|spawn|child_process|shell|command/i, "command execution path changed"],
    [/fetch|WebSocket|http|https|request/i, "network boundary changed"],
    [/cron|schedule|timer|interval/i, "scheduled workflow changed"],
    [/permission|allowlist|deny|sandbox|policy/i, "permission or sandbox policy changed"],
    [/memory|session|jsonl|append/i, "memory/session persistence changed"],
    [/compact|context|token/i, "context compaction or token budgeting changed"],
  ];
  for (const [pattern, message] of checks) {
    if (pattern.test(text)) {
      signals.push(message);
    }
  }
  return [...new Set(signals)];
}

function buildPlan(files) {
  const allRepoFiles = new Set(splitLines(git(["ls-files"], "")));
  const entries = files.map((file) => ({
    file,
    kind: classify(file),
    candidateTests: candidateTestFiles(file, allRepoFiles),
    riskSignals: extractRiskSignals(file),
  }));

  const commands = new Set();
  const testFiles = new Set(
    entries.flatMap((entry) => (entry.kind === "test" ? [entry.file] : entry.candidateTests)),
  );
  if (testFiles.size > 0) {
    commands.add(
      `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit-fast.config.ts ${[...testFiles].join(" ")}`,
    );
  }
  if (entries.some((entry) => entry.kind === "docs")) {
    commands.add("pnpm format:docs:check && pnpm lint:docs");
  }
  if (entries.some((entry) => entry.kind === "script")) {
    for (const file of entries
      .filter((entry) => entry.kind === "script")
      .map((entry) => entry.file)) {
      if (/\.(mjs|js|cjs)$/.test(file)) {
        commands.add(`node --check ${file}`);
      }
    }
  }
  if (entries.some((entry) => entry.kind === "ui")) {
    commands.add("pnpm test:ui");
  }
  if (entries.some((entry) => ["core", "extension", "package"].includes(entry.kind))) {
    commands.add("pnpm test:unit:fast");
  }

  const mutationPrompts = entries
    .filter((entry) => entry.riskSignals.length > 0)
    .map((entry) => ({
      file: entry.file,
      prompt: `Create one catching test for ${entry.file}. Infer the intended behavior from the diff, then mutate the implementation around: ${entry.riskSignals.join("; ")}. The test should fail on the realistic mutant and pass on the intended implementation.`,
    }));

  return {
    generatedAt: new Date().toISOString(),
    base: git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown"),
    changedFiles: files,
    entries,
    commands: [...commands],
    mutationPrompts,
    humanCheckpoint:
      "Review generated tests before committing. Catching tests should target regressions introduced by this diff, not broaden unrelated coverage.",
  };
}

function renderMarkdown(plan) {
  const lines = [
    "# JiT Diff Test Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Changed files: ${plan.changedFiles.length}`,
    "",
    "## Commands",
    "",
  ];
  if (plan.commands.length === 0) {
    lines.push("- No targeted commands found; run the smallest relevant package test manually.");
  } else {
    for (const command of plan.commands) {
      lines.push(`- \`${command}\``);
    }
  }

  lines.push("", "## Changed Files", "");
  for (const entry of plan.entries) {
    lines.push(`- ${entry.file} (${entry.kind})`);
    if (entry.candidateTests.length > 0) {
      lines.push(`  Candidate tests: ${entry.candidateTests.join(", ")}`);
    }
    if (entry.riskSignals.length > 0) {
      lines.push(`  Risk signals: ${entry.riskSignals.join("; ")}`);
    }
  }

  lines.push("", "## Mutation-Style Catching Test Prompts", "");
  if (plan.mutationPrompts.length === 0) {
    lines.push("- No high-risk implementation files detected.");
  } else {
    for (const item of plan.mutationPrompts) {
      lines.push(`- ${item.prompt}`);
    }
  }
  lines.push("", `Human checkpoint: ${plan.humanCheckpoint}`);
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const files = changedFiles(args.base, args.includeUntracked);
const plan = buildPlan(files);
const output = args.json ? `${JSON.stringify(plan, null, 2)}\n` : renderMarkdown(plan);
if (args.output) {
  mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
