#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    json: false,
    output: null,
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
  console.log(`Usage: node scripts/headless-capability-registry.mjs [options]

Generate a headless capability registry from package scripts, workflows, and browser flows.

Options:
  --repo <path>       Repository path
  --json              Print JSON
  --output <path>     Write report to file
`);
}

function readJson(file) {
  if (!existsSync(file)) {
    return null;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function listFiles(dir, predicate) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function packageCapabilities(repo) {
  const pkg = readJson(path.join(repo, "package.json"));
  const scripts = pkg?.scripts ?? {};
  return Object.entries(scripts)
    .filter(([name]) =>
      /agent-marketplace|audit|browser|business-agent|channels:policy|check|docs|headless:registry|lint|local-model|repo:roi|subagents|test:jit|test:changed|test:reliability|tunnel:policy/i.test(
        name,
      ),
    )
    .map(([name, command]) => ({
      id: `script:${name}`,
      kind: "cli",
      name,
      command: `pnpm ${name}`,
      description: command,
      sideEffect: /fix|write|sync|publish|merge|push|release/i.test(name) ? "write" : "read-mostly",
      humanCheckpoint: /publish|merge|push|release|fix|write|sync/i.test(name),
    }));
}

function workflowCapabilities() {
  const dir = path.join(process.env.HOME ?? "", ".openclaw", "workflows");
  return listFiles(dir, (name) => name.endsWith(".md")).map((file) => {
    const text = readFileSync(file, "utf8");
    return {
      id: `workflow:${path.basename(file, ".md")}`,
      kind: "workflow",
      name: path.basename(file, ".md"),
      path: file,
      description:
        text
          .split("\n")
          .find((line) => line.startsWith("Goal:"))
          ?.replace(/^Goal:\s*/, "") ?? "OpenClaw workflow prompt",
      sideEffect: /Do not|Read-only|draft/i.test(text) ? "read-mostly" : "review-required",
      humanCheckpoint: /Human checkpoint: required/i.test(text),
    };
  });
}

function browserFlowCapabilities(repo) {
  const dir = path.join(repo, "automation", "browser-flows");
  return listFiles(dir, (name) => name.endsWith(".json")).map((file) => {
    const spec = readJson(file) ?? {};
    return {
      id: `browser-flow:${path.basename(file, ".json")}`,
      kind: "browser-flow",
      name: spec.name ?? path.basename(file, ".json"),
      path: file,
      description: spec.description ?? "Browser flow",
      command: `pnpm browser:flow -- --spec ${path.relative(repo, file)}`,
      sideEffect: "read-mostly",
      humanCheckpoint: true,
    };
  });
}

function subagentCapabilities(repo) {
  const dir = path.join(repo, ".gemini", "agents");
  return listFiles(dir, (name) => name.endsWith(".md")).map((file) => {
    const text = readFileSync(file, "utf8");
    const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? path.basename(file, ".md");
    const description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "Specialist subagent";
    return {
      id: `subagent:${name}`,
      kind: "subagent",
      name,
      path: file,
      description,
      sideEffect: /Do not modify|read-only|Do not apply fixes/i.test(text)
        ? "read-mostly"
        : "review-required",
      humanCheckpoint: /human approval|required before|Human approval/i.test(text),
    };
  });
}

function buildRegistry(args) {
  const repo = path.resolve(args.repo);
  const capabilities = [
    ...packageCapabilities(repo),
    ...workflowCapabilities(),
    ...browserFlowCapabilities(repo),
    ...subagentCapabilities(repo),
  ].toSorted((a, b) => a.id.localeCompare(b.id));
  return {
    generatedAt: new Date().toISOString(),
    repo,
    capabilities,
    summary: {
      total: capabilities.length,
      byKind: capabilities.reduce((acc, capability) => {
        acc[capability.kind] = (acc[capability.kind] ?? 0) + 1;
        return acc;
      }, {}),
      humanCheckpoint: capabilities.filter((capability) => capability.humanCheckpoint).length,
    },
  };
}

function renderMarkdown(registry) {
  const lines = [
    "# Headless Capability Registry",
    "",
    `Generated: ${registry.generatedAt}`,
    `Capabilities: ${registry.summary.total}`,
    "",
    "## Capabilities",
    "",
  ];
  for (const capability of registry.capabilities) {
    lines.push(`- ${capability.id} (${capability.kind})`);
    lines.push(`  Description: ${capability.description}`);
    if (capability.command) {
      lines.push(`  Command: \`${capability.command}\``);
    }
    if (capability.path) {
      lines.push(`  Path: \`${capability.path}\``);
    }
    lines.push(`  Side effect: ${capability.sideEffect}`);
    lines.push(`  Human checkpoint: ${capability.humanCheckpoint ? "yes" : "no"}`);
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const registry = buildRegistry(args);
const output = args.json ? `${JSON.stringify(registry, null, 2)}\n` : renderMarkdown(registry);
if (args.output) {
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
