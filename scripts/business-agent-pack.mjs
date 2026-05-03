#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    outputDir: path.join(homedir(), ".openclaw", "review", "business-agents"),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
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
  console.log(`Usage: node scripts/business-agent-pack.mjs [options]

Create reviewable done-for-you business agent pack drafts.

Options:
  --output-dir <path>   Output folder (default: ~/.openclaw/review/business-agents)
  --json                Print manifest JSON
`);
}

const agents = [
  {
    id: "content-studio",
    name: "Content Studio Agent",
    priceBand: "$500-$2,000/mo",
    inputs: ["topic", "reference links", "brand voice", "target channel"],
    outputs: ["script draft", "post variants", "thumbnail/infographic brief", "review checklist"],
    checkpoint: "Human approves copy, images, and publishing.",
  },
  {
    id: "research-briefing",
    name: "Research Briefing Agent",
    priceBand: "$300-$1,500/mo",
    inputs: ["watchlist", "competitors", "keywords", "trusted sources"],
    outputs: ["daily brief", "opportunity notes", "citations", "follow-up tasks"],
    checkpoint: "Human approves outbound messages or public claims.",
  },
  {
    id: "sales-ops",
    name: "Sales Ops Agent",
    priceBand: "$750-$3,000/mo",
    inputs: ["lead list", "ICP", "offer", "CRM export"],
    outputs: ["qualified lead notes", "draft outreach", "CRM update plan", "risk flags"],
    checkpoint: "Human approves outreach and CRM writes.",
  },
];

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${text.trimEnd()}\n`, { mode: 0o600 });
}

function agentMarkdown(agent) {
  return `# ${agent.name}

Price band: ${agent.priceBand}

## Job To Replace

Recurring human work that is expensive to context-load and cheap to review.

## Inputs

${agent.inputs.map((input) => `- ${input}`).join("\n")}

## Outputs

${agent.outputs.map((output) => `- ${output}`).join("\n")}

## Delivery Contract

- Agent produces drafts and evidence under this review folder.
- Agent does not publish, email, edit CRM, spend money, or change credentials.
- ${agent.checkpoint}

## Reusable Skill Prompt

Read the shared business brain, project context, and any client-specific constraints. Produce the requested asset pack with citations or source notes where applicable. Put all deliverables in a dated review folder and finish with a concise approval checklist.
`;
}

function manifest(outputDir) {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    outputDir,
    agents,
    productizationRules: [
      "Sell recurring outcomes, not raw chatbot access.",
      "Every agent must have explicit inputs, outputs, pricing band, and human checkpoint.",
      "Use skills/plugins as reusable assets across clients.",
      "External messages, publishing, CRM writes, and credential changes remain human-only.",
    ],
  };
}

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir);
for (const agent of agents) {
  write(path.join(outputDir, `${agent.id}.md`), agentMarkdown(agent));
}
const result = manifest(outputDir);
write(path.join(outputDir, "manifest.json"), JSON.stringify(result, null, 2));
write(
  path.join(outputDir, "README.md"),
  `# Business Agent Pack

Generated: ${result.generatedAt}

This folder contains reviewable product specs for reusable done-for-you business agents.

${agents.map((agent) => `- ${agent.name}: \`${agent.id}.md\``).join("\n")}
`,
);
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Business agent pack written to ${outputDir}`);
}
