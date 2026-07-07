#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  prepareOllamaForLiveWorkflow,
  resolveRunLiveWorkflowConfig,
  resolveLiveWorkflowConfig,
  runLiveWorkflowEvals,
  stopOllamaForLiveWorkflow,
  verifyLiveWorkflowReport,
} from "./lib/agent-role-eval-workflow.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/agent-role-eval-workflow.mjs prepare-ollama",
    "  node scripts/agent-role-eval-workflow.mjs run-live",
    "  node scripts/agent-role-eval-workflow.mjs verify-report [report-dir]",
    "  node scripts/agent-role-eval-workflow.mjs stop-ollama",
    "  node scripts/agent-role-eval-workflow.mjs resolve [--run-live] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { command: argv[0], json: false, runLive: false };
  for (const arg of argv.slice(1)) {
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--run-live") {
      args.runLive = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (args.command === "verify-report" && !args.reportDir) {
      args.reportDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    console.log(usage());
    return 0;
  }
  if (args.command === "prepare-ollama") {
    return prepareOllamaForLiveWorkflow();
  }
  if (args.command === "run-live") {
    return runLiveWorkflowEvals();
  }
  if (args.command === "verify-report") {
    const result = verifyLiveWorkflowReport({ reportDir: args.reportDir });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Agent role live eval report: ${result.ok ? "passed" : "failed"}`);
      if (result.reportDir) {
        console.log(`Report dir: ${result.reportDir}`);
      }
      console.log(`Results checked: ${result.resultCount ?? 0}`);
      if (result.issues.length > 0) {
        console.log("");
        for (const issue of result.issues) {
          console.log(`- ${issue}`);
        }
      }
    }
    return result.ok ? 0 : 1;
  }
  if (args.command === "stop-ollama") {
    return stopOllamaForLiveWorkflow();
  }
  if (args.command === "resolve") {
    const config = args.runLive ? resolveRunLiveWorkflowConfig() : resolveLiveWorkflowConfig();
    if (args.json) {
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.log(`model=${config.model}`);
      console.log(`agents=${config.agents.join(",")}`);
      console.log(`timeoutSeconds=${config.timeoutSeconds}`);
      console.log(`ollamaMinMemMb=${config.ollamaMinMemMb}`);
      console.log(`bootstrapOllama=${config.bootstrapOllama}`);
    }
    return 0;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
