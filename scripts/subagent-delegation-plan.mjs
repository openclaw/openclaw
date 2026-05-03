#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    base: "origin/main",
    includeUntracked: true,
    json: false,
    output: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--base") {
      args.base = argv[++i] ?? args.base;
    } else if (arg === "--tracked-only") {
      args.includeUntracked = false;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++i] ?? args.output;
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
  console.log(`Usage: node scripts/subagent-delegation-plan.mjs [options]

Create a conflict-aware delegation plan for Gemini/OpenClaw specialist subagents.

Options:
  --base <ref>       Base ref for changed files (default: origin/main)
  --tracked-only     Ignore untracked files
  --json             Print JSON
  --output <path>    Write report
`);
}

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return fallback;
  }
}

function splitLines(text) {
  return text
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

function readAgentNames() {
  const dir = path.join(process.cwd(), ".gemini", "agents");
  if (!existsSync(dir)) {
    return new Set();
  }
  return new Set(
    splitLines(git(["ls-files", ".gemini/agents/*.md"], ""))
      .map((file) =>
        readFileSync(file, "utf8")
          .match(/^name:\s*(.+)$/m)?.[1]
          ?.trim(),
      )
      .filter(Boolean),
  );
}

function classifyFile(file) {
  if (file.startsWith(".gemini/agents/")) {
    return "subagent-roster";
  }
  if (file.startsWith("automation/browser-flows/") || file.includes("playwright-flow")) {
    return "browser-flow";
  }
  if (
    file.includes("security") ||
    file.includes("hardening") ||
    file.includes("policy") ||
    file.includes("auth")
  ) {
    return "security";
  }
  if (file.includes("test") || file.includes("jit") || file.includes("vitest")) {
    return "testing";
  }
  if (file.startsWith("docs/") || file.endsWith(".md") || file.startsWith("skills/")) {
    return "docs-or-skills";
  }
  if (file.startsWith("scripts/") || file.endsWith(".mjs")) {
    return "scripts";
  }
  if (file.startsWith("ui/")) {
    return "ui";
  }
  return "codebase";
}

function agentForKind(kind) {
  switch (kind) {
    case "browser-flow":
      return "browser-flow-debugger";
    case "security":
      return "security-hardening-reviewer";
    case "testing":
      return "jit-test-designer";
    case "docs-or-skills":
      return "business-agent-packager";
    case "subagent-roster":
    case "scripts":
    case "ui":
    case "codebase":
    default:
      return "codebase-investigator";
  }
}

function sideEffectForKind(kind) {
  if (kind === "docs-or-skills" || kind === "testing" || kind === "codebase") {
    return "read-mostly";
  }
  return "review-required";
}

function buildPlan(args) {
  const agents = readAgentNames();
  const files = changedFiles(args.base, args.includeUntracked);
  const assignmentsByAgent = new Map();
  for (const file of files) {
    const kind = classifyFile(file);
    const agent = agentForKind(kind);
    if (!assignmentsByAgent.has(agent)) {
      assignmentsByAgent.set(agent, []);
    }
    assignmentsByAgent.get(agent).push({
      file,
      kind,
      sideEffect: sideEffectForKind(kind),
    });
  }

  const assignments = [...assignmentsByAgent.entries()]
    .map(([agent, items]) => ({
      agent,
      available: agents.has(agent),
      parallelSafe: items.every((item) => item.sideEffect === "read-mostly"),
      files: items,
    }))
    .toSorted((a, b) => a.agent.localeCompare(b.agent));

  return {
    generatedAt: new Date().toISOString(),
    base: args.base,
    changedFileCount: files.length,
    assignments,
    summary: {
      agents: assignments.length,
      available: assignments.filter((assignment) => assignment.available).length,
      parallelSafe: assignments.filter((assignment) => assignment.parallelSafe).length,
      reviewRequired: assignments.filter((assignment) => !assignment.parallelSafe).length,
    },
    policy:
      "Use assignments marked parallelSafe for parallel read-only review. Require explicit file ownership before write-capable parallel edits.",
  };
}

function renderMarkdown(plan) {
  const lines = [
    "# Subagent Delegation Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Base: \`${plan.base}\``,
    `Changed files: ${plan.changedFileCount}`,
    "",
    "## Assignments",
    "",
  ];
  for (const assignment of plan.assignments) {
    lines.push(`### @${assignment.agent}`);
    lines.push(`Available: ${assignment.available ? "yes" : "no"}`);
    lines.push(`Parallel safe: ${assignment.parallelSafe ? "yes" : "review-required"}`);
    lines.push("");
    for (const item of assignment.files) {
      lines.push(`- ${item.file} (${item.kind}, ${item.sideEffect})`);
    }
    lines.push("");
  }
  lines.push("## Policy", "", plan.policy);
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const plan = buildPlan(args);
const output = args.json ? `${JSON.stringify(plan, null, 2)}\n` : renderMarkdown(plan);
if (args.output) {
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
