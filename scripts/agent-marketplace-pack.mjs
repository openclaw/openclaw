#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: path.join(homedir(), ".openclaw", "review", "business-agents", "manifest.json"),
    outputDir: path.join(homedir(), ".openclaw", "review", "agent-marketplace"),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--input") {
      args.input = argv[++i] ?? args.input;
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++i] ?? args.outputDir;
    } else if (arg === "--json") {
      args.json = true;
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
  console.log(`Usage: node scripts/agent-marketplace-pack.mjs [options]

Create marketplace-readiness listings for reusable business agents.

Options:
  --input <path>       Business agent manifest JSON
  --output-dir <path>  Output folder
  --json               Print manifest JSON
`);
}

function readAgents(file) {
  if (!existsSync(file)) {
    throw new Error(
      `Business agent manifest not found: ${file}. Run pnpm business-agent:pack first.`,
    );
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed.agents) ? parsed.agents : [];
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${text.trimEnd()}\n`, { mode: 0o600 });
}

function listing(agent) {
  return {
    id: agent.id,
    name: agent.name,
    category: categoryFor(agent.id),
    shortDescription: `${agent.name} turns structured inputs into reviewable outputs with human approval before external actions.`,
    targetBuyer: buyerFor(agent.id),
    priceBand: agent.priceBand,
    inputs: agent.inputs,
    outputs: agent.outputs,
    trustControls: [
      "Human checkpoint before external actions",
      "No credential storage in prompts or skill files",
      "Review-folder delivery by default",
      "Screenshots/traces required for browser automation",
      "Access policy must be default-deny for chat channels",
    ],
    distributionStatus: "internal-review",
    publishBlockers: [
      "Add customer-facing demo screenshots or sanitized sample outputs",
      "Confirm licensing and third-party source credits",
      "Confirm support owner and escalation path",
      "Run security/hardening checks before client deployment",
    ],
  };
}

function categoryFor(id) {
  if (id.includes("content")) {
    return "Marketing";
  }
  if (id.includes("research")) {
    return "Research";
  }
  if (id.includes("sales")) {
    return "Sales Operations";
  }
  return "Operations";
}

function buyerFor(id) {
  if (id.includes("content")) {
    return "Founder, creator, or marketing lead";
  }
  if (id.includes("research")) {
    return "Founder, analyst, investor, or operator";
  }
  if (id.includes("sales")) {
    return "B2B founder, sales lead, or agency";
  }
  return "Operations lead";
}

function listingMarkdown(item) {
  return `# ${item.name}

Category: ${item.category}
Status: ${item.distributionStatus}
Price band: ${item.priceBand}
Target buyer: ${item.targetBuyer}

## Description

${item.shortDescription}

## Inputs

${item.inputs.map((input) => `- ${input}`).join("\n")}

## Outputs

${item.outputs.map((output) => `- ${output}`).join("\n")}

## Trust Controls

${item.trustControls.map((control) => `- ${control}`).join("\n")}

## Publish Blockers

${item.publishBlockers.map((blocker) => `- [ ] ${blocker}`).join("\n")}
`;
}

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir);
const agents = readAgents(path.resolve(args.input));
const listings = agents.map(listing);
for (const item of listings) {
  write(path.join(outputDir, `${item.id}.md`), listingMarkdown(item));
}
const manifest = {
  generatedAt: new Date().toISOString(),
  outputDir,
  source: path.resolve(args.input),
  listings,
  rules: [
    "Marketplace listings are drafts until a human approves publishing.",
    "Trust controls must be true before any client-facing deployment.",
    "Agent access must be scoped per customer and default-deny.",
  ],
};
write(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
if (args.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(`Agent marketplace pack written to ${outputDir}`);
}
