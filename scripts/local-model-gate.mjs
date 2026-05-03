#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    model: "gemma4:e4b",
    output: path.join(homedir(), ".openclaw", "reports", "models", "local-model-gate.md"),
    watchlist: path.join(process.cwd(), "automation", "models", "watchlist.json"),
    json: false,
    smoke: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--model") {
      args.model = argv[++i] ?? args.model;
    } else if (arg === "--output") {
      args.output = argv[++i] ?? args.output;
    } else if (arg === "--watchlist") {
      args.watchlist = argv[++i] ?? args.watchlist;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--smoke") {
      args.smoke = true;
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
  console.log(`Usage: node scripts/local-model-gate.mjs [options]

Check whether a local Ollama/Gemma-style model is suitable for private agent work.

Options:
  --model <name>      Model tag to check (default: gemma4:e4b)
  --smoke             Run a tiny local smoke prompt through ollama run
  --output <path>     Write Markdown report
  --watchlist <path>  Model watchlist JSON
  --json              Print JSON
`);
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeout ?? 15000,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message,
    };
  }
}

function parseOllamaList(text) {
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function readWatchlist(file) {
  if (!existsSync(file)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed.models) ? parsed.models : [];
}

function recommendation(memoryGb) {
  if (memoryGb >= 32) {
    return "Local private RAG/summarization is appropriate; keep coding and repo mutation on cloud models unless smoke tests prove otherwise.";
  }
  if (memoryGb >= 16) {
    return "Use local models for private summarization, classification, and draft retrieval; avoid autonomous code edits.";
  }
  return "Use local models only for small private classification/summarization tasks.";
}

function buildReport(args) {
  const memoryGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const watchlist = readWatchlist(path.resolve(args.watchlist));
  const modelPolicy = watchlist.find((item) => item.id === args.model) ?? null;
  const ollamaVersion = run("ollama", ["--version"]);
  const ollamaList = run("ollama", ["list"]);
  const installedModels = ollamaList.ok ? parseOllamaList(ollamaList.stdout) : [];
  const modelInstalled = installedModels.includes(args.model);
  const smoke =
    args.smoke && modelInstalled
      ? run("ollama", ["run", args.model, "Reply with exactly: local-model-ok"], { timeout: 45000 })
      : null;

  const findings = [];
  if (modelPolicy?.localMemoryGbRequired && memoryGb < modelPolicy.localMemoryGbRequired) {
    findings.push(
      `Host memory ${memoryGb} GB is below ${modelPolicy.localMemoryGbRequired} GB required for ${args.model}.`,
    );
  }
  if (!ollamaVersion.ok) {
    findings.push("Ollama CLI is not available.");
  }
  if (ollamaVersion.ok && !modelInstalled) {
    findings.push(`Model ${args.model} is not installed.`);
  }
  if (smoke && !smoke.ok) {
    findings.push(`Smoke prompt failed for ${args.model}.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    model: args.model,
    modelPolicy,
    memoryGb,
    ollamaAvailable: ollamaVersion.ok,
    ollamaVersion: ollamaVersion.ok ? ollamaVersion.stdout.trim() : null,
    installedModels,
    modelInstalled,
    smoke: smoke
      ? {
          ok: smoke.ok,
          output: smoke.stdout.trim().slice(0, 500),
          error: smoke.ok ? null : smoke.stderr.slice(0, 500),
        }
      : null,
    recommendation: recommendation(memoryGb),
    gate: findings.length === 0 ? "pass" : "review",
    findings,
    watchlist: watchlist.map((item) => ({
      id: item.id,
      provider: item.provider,
      localMemoryGbRequired: item.localMemoryGbRequired,
      status: item.status,
      feasibleOnThisHost: !item.localMemoryGbRequired || memoryGb >= item.localMemoryGbRequired,
    })),
  };
}

function renderMarkdown(report) {
  return `# Local Model Gate

Generated: ${report.generatedAt}
Model: \`${report.model}\`
Gate: ${report.gate}

## Host

- Memory: ${report.memoryGb} GB
- Ollama available: ${report.ollamaAvailable ? "yes" : "no"}
- Ollama version: ${report.ollamaVersion ?? "n/a"}
- Model installed: ${report.modelInstalled ? "yes" : "no"}

## Recommendation

${report.recommendation}

## Model Policy

${
  report.modelPolicy
    ? `- Provider: ${report.modelPolicy.provider}
- Required memory: ${report.modelPolicy.localMemoryGbRequired ?? "unknown"} GB
- Recommended use: ${report.modelPolicy.recommendedUse}
- Status: ${report.modelPolicy.status}`
    : "- No watchlist entry for this model."
}

## Policy

- Local models may handle private summarization, RAG, classification, and draft generation.
- Cloud models remain the default for complex code generation, production fixes, and multi-file refactors.
- No local model enters cron, chat-channel control, or live config until this gate passes with a smoke test.

## Findings

${report.findings.length ? report.findings.map((finding) => `- ${finding}`).join("\n") : "- None"}

## Installed Models

${report.installedModels.length ? report.installedModels.map((model) => `- \`${model}\``).join("\n") : "- None detected"}

## Watchlist

${report.watchlist
  .map(
    (item) =>
      `- \`${item.id}\` (${item.provider}): ${item.feasibleOnThisHost ? "local-feasible" : "remote/watchlist"}; required memory ${item.localMemoryGbRequired ?? "unknown"} GB; status ${item.status}`,
  )
  .join("\n")}
`;
}

const args = parseArgs(process.argv.slice(2));
const report = buildReport(args);
const output = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
if (args.output) {
  mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
}
process.stdout.write(output);
