#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    dir: path.join(process.cwd(), ".gemini", "agents"),
    json: false,
    output: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--dir") {
      args.dir = argv[++i] ?? args.dir;
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
  console.log(`Usage: node scripts/subagent-roster-check.mjs [options]

Validate Gemini CLI subagent definitions for bounded tools and review-first behavior.

Options:
  --dir <path>      Agents directory (default: .gemini/agents)
  --json            Print JSON
  --output <path>   Write report
`);
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4).trim();
  const frontmatter = {};
  let currentList = null;
  for (const line of raw.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentList) {
      frontmatter[currentList].push(listItem[1].trim());
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      continue;
    }
    const [, key, value] = pair;
    if (value === "") {
      frontmatter[key] = [];
      currentList = key;
    } else {
      frontmatter[key] = value.trim().replace(/^["']|["']$/g, "");
      currentList = null;
    }
  }
  return { frontmatter, body };
}

function agentFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .toSorted();
}

function validateAgent(file) {
  const text = readFileSync(file, "utf8");
  const { frontmatter, body } = parseFrontmatter(text);
  const findings = [];
  const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools : [];
  if (!frontmatter.name) {
    findings.push("missing name");
  }
  if (!frontmatter.description || String(frontmatter.description).length < 40) {
    findings.push("description must be specific enough for routing");
  }
  if (!tools.length) {
    findings.push("tools must be explicitly restricted");
  }
  if (tools.includes("*") || tools.includes("shell") || tools.includes("run_shell_command")) {
    findings.push("unbounded shell tools are not allowed in shared subagents");
  }
  if (!/do not|do not modify|report|suggest|human/i.test(body)) {
    findings.push("body must include review-first or non-destructive instructions");
  }
  if (/merge|deploy|publish|credential|secret/i.test(body) && !/human/i.test(body)) {
    findings.push("risky external actions must require human approval");
  }
  return {
    file,
    name: frontmatter.name ?? path.basename(file, ".md"),
    tools,
    ok: findings.length === 0,
    findings,
  };
}

function buildReport(args) {
  const dir = path.resolve(args.dir);
  const agents = agentFiles(dir).map(validateAgent);
  return {
    generatedAt: new Date().toISOString(),
    dir,
    ok: agents.every((agent) => agent.ok),
    agents,
    summary: {
      total: agents.length,
      passing: agents.filter((agent) => agent.ok).length,
      failing: agents.filter((agent) => !agent.ok).length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Subagent Roster Check",
    "",
    `Generated: ${report.generatedAt}`,
    `Directory: \`${report.dir}\``,
    `Status: ${report.ok ? "pass" : "review"}`,
    "",
    "## Agents",
    "",
  ];
  for (const agent of report.agents) {
    lines.push(`- ${agent.name}: ${agent.ok ? "pass" : "review"}`);
    lines.push(`  File: \`${agent.file}\``);
    lines.push(
      `  Tools: ${agent.tools.length ? agent.tools.map((tool) => `\`${tool}\``).join(", ") : "none"}`,
    );
    if (agent.findings.length) {
      lines.push(`  Findings: ${agent.findings.join("; ")}`);
    }
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
if (!report.ok) {
  process.exitCode = 1;
}
