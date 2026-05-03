#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    json: false,
    output: null,
    maxFiles: 25,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--repo") {
      args.repo = argv[++i] ?? args.repo;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++i] ?? args.output;
    } else if (arg === "--max-files") {
      args.maxFiles = Number(argv[++i] ?? args.maxFiles);
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
  console.log(`Usage: node scripts/repo-roi-playbook.mjs [options]

Generate a reviewable high-ROI delegation brief for a repository.

Options:
  --repo <path>       Repository path
  --json              Print JSON
  --output <path>     Write report to file
  --max-files <n>     Max hotspot files to include
`);
}

function git(repo, args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function readIfExists(file, maxChars = 12_000) {
  if (!existsSync(file)) {
    return null;
  }
  return readFileSync(file, "utf8").slice(0, maxChars);
}

function listTopLevel(repo) {
  return readdirSync(repo, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.name.startsWith(".") && !["node_modules", "dist", "build"].includes(entry.name),
    )
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }))
    .slice(0, 80);
}

function packageScripts(repo) {
  const pkg = readIfExists(path.join(repo, "package.json"), 80_000);
  if (!pkg) {
    return {};
  }
  try {
    return JSON.parse(pkg).scripts ?? {};
  } catch {
    return {};
  }
}

function changedHotspots(repo, maxFiles) {
  const output = git(repo, ["log", "--since=90 days ago", "--name-only", "--pretty=format:"], "");
  const counts = new Map();
  for (const line of output
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, maxFiles)
    .map(([file, changes]) => ({ file, changes }));
}

function detectStack(repo, scripts, topLevel) {
  const names = new Set(topLevel.map((entry) => entry.name));
  const stack = [];
  if (existsSync(path.join(repo, "package.json"))) {
    stack.push("node");
  }
  if (names.has("pnpm-lock.yaml")) {
    stack.push("pnpm");
  }
  if (names.has("apps")) {
    stack.push("monorepo-apps");
  }
  if (names.has("src")) {
    stack.push("typescript-or-js-core");
  }
  if (names.has("docs")) {
    stack.push("docs");
  }
  if (Object.keys(scripts).some((name) => name.includes("test"))) {
    stack.push("tests");
  }
  if (Object.keys(scripts).some((name) => name.includes("lint"))) {
    stack.push("lint");
  }
  return stack;
}

function buildCandidates({ scripts, stack, hotspots }) {
  const candidates = [];
  const hasTests = stack.includes("tests");
  const hasDocs = stack.includes("docs");
  if (hasTests) {
    candidates.push({
      title: "JiT catching-test pass for current diff",
      why: "Review effort is small and test output is mechanically verifiable.",
      delegate:
        "Generate targeted tests from the diff, run the smallest listed commands, and summarize failures.",
      verify: "Run test:jit:plan plus the targeted test command.",
    });
  }
  if (hotspots.length > 0) {
    candidates.push({
      title: "Hotspot impact analysis",
      why: "Frequently changed files are expensive for humans to reload and easy for agents to map.",
      delegate: `Explain risks and refactor opportunities in ${hotspots
        .slice(0, 5)
        .map((item) => item.file)
        .join(", ")}.`,
      verify:
        "Review file references and accept only changes covered by existing or generated tests.",
    });
  }
  if (hasDocs) {
    candidates.push({
      title: "Docs drift check",
      why: "Docs are easy to review and often lag behind code changes.",
      delegate: "Compare README/docs against changed code paths and draft minimal updates.",
      verify: "Run docs format/lint checks.",
    });
  }
  if (scripts.lint || scripts.check) {
    candidates.push({
      title: "Mechanical refactor with lint gate",
      why: "Pattern-following edits are high leverage when lint/check commands exist.",
      delegate: "Consolidate obvious duplication or error handling in one bounded module.",
      verify: `Run ${scripts.check ? "check" : "lint"} and targeted tests.`,
    });
  }
  candidates.push({
    title: "PR-ready feature scaffold",
    why: "Routes, handlers, types, config, and tests are tedious but reviewable.",
    delegate:
      "Propose one roadmap-aligned feature, wait for selection, then scaffold only the selected path.",
    verify: "Review diff, run targeted tests, then open a draft PR.",
  });
  return candidates;
}

function buildReport(args) {
  const repo = path.resolve(args.repo);
  const topLevel = listTopLevel(repo);
  const scripts = packageScripts(repo);
  const hotspots = changedHotspots(repo, args.maxFiles);
  const stack = detectStack(repo, scripts, topLevel);
  const readme = readIfExists(path.join(repo, "README.md"), 4_000);
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], "unknown");
  const dirty = git(repo, ["status", "--short"], "");
  return {
    generatedAt: new Date().toISOString(),
    repo,
    branch,
    dirtyFiles: dirty.split("\n").filter(Boolean).length,
    stack,
    topLevel,
    scripts: Object.fromEntries(
      Object.entries(scripts)
        .filter(([name]) => /test|lint|check|build|dev|start|format/i.test(name))
        .slice(0, 60),
    ),
    hotspots,
    readmeSignals: readme
      ? readme
          .split("\n")
          .filter((line) => /^#|feature|roadmap|usage|install|test/i.test(line))
          .slice(0, 20)
      : [],
    candidates: buildCandidates({ scripts, stack, hotspots }),
    humanOnly: [
      "Architecture/product direction",
      "Credential changes",
      "Public posting or customer communication",
      "Merging/releasing",
      "Large irreversible migrations",
    ],
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Repo ROI Playbook",
    "",
    `Generated: ${report.generatedAt}`,
    `Repo: ${report.repo}`,
    `Branch: ${report.branch}`,
    `Dirty files: ${report.dirtyFiles}`,
    `Stack: ${report.stack.join(", ") || "unknown"}`,
    "",
    "## High-ROI Delegations",
    "",
  ];
  for (const item of report.candidates) {
    lines.push(
      `### ${item.title}`,
      "",
      `Why: ${item.why}`,
      "",
      `Delegate: ${item.delegate}`,
      "",
      `Verify: ${item.verify}`,
      "",
    );
  }
  lines.push("## Hotspots", "");
  if (report.hotspots.length === 0) {
    lines.push("- No 90-day git hotspots detected.");
  } else {
    for (const item of report.hotspots) {
      lines.push(`- ${item.file} (${item.changes} changes)`);
    }
  }
  lines.push("", "## Human-Only", "");
  for (const item of report.humanOnly) {
    lines.push(`- ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const report = buildReport(args);
const output = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
if (args.output) {
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
