#!/usr/bin/env node
/**
 * Aggregate OpenClaw hook/tool/model timing by runId from raw logs (+ stability bundles).
 *
 * Raw JSONL logs supply runId/session boundaries; stability bundles supply hook/tool/model
 * durations when diagnostics.enabled is on (events are not always written to text logs).
 *
 * Usage:
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --format breakdown-tsv
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --format events-tsv
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --monitor-traces ./traces.json
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --run-id <id>
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --log ~/.openclaw/logs/openclaw-2026-07-10.log
 *   node extensions/performance-monitor/scripts/aggregate-run-timing-from-logs.mjs --logs-only
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateRunTiming,
  formatBreakdownTsv,
  formatEventsTsv,
  formatRunSummaryTsv,
  resolveDefaultLogPaths,
} from "./lib/aggregate-run-timing.mjs";

function usage() {
  const defaults = resolveDefaultLogPaths();
  process.stderr.write(`Usage: aggregate-run-timing-from-logs.mjs [options]

Options:
  --format <jsonl|tsv|events-tsv|breakdown-tsv|json>   Output format (default: jsonl)
  --run-id <runId>            Filter to one run
  --log <path>                Log file (repeatable)
  --stability <path>          Stability bundle JSON (repeatable)
  --agent-jsonl <path>        Agent CLI --json batch results (repeatable)
  --monitor-traces <path>     performance-monitor full run traces JSON (repeatable)
  --logs-dir <path>           Log directory (default: ${defaults.logsDir})
  --stability-dir <path>      Stability dir (default: ${defaults.stabilityDir})
  --logs-only                 Skip stability bundles (hook/tool/model coverage reduced)
  --help                      Show this help
`);
}

function parseArgs(argv) {
  /** @type {{ format: string; runId?: string; logPaths: string[]; stabilityPaths: string[]; agentJsonlPaths: string[]; monitorTracePaths: string[]; logsDir?: string; stabilityDir?: string; includeStability: boolean }} */
  const options = {
    format: "jsonl",
    logPaths: [],
    stabilityPaths: [],
    agentJsonlPaths: [],
    monitorTracePaths: [],
    includeStability: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--format":
        options.format = argv[++index] ?? "jsonl";
        break;
      case "--run-id":
        options.runId = argv[++index];
        break;
      case "--log":
        options.logPaths.push(argv[++index] ?? "");
        break;
      case "--stability":
        options.stabilityPaths.push(argv[++index] ?? "");
        break;
      case "--agent-jsonl":
        options.agentJsonlPaths.push(argv[++index] ?? "");
        break;
      case "--monitor-traces":
        options.monitorTracePaths.push(argv[++index] ?? "");
        break;
      case "--logs-dir":
        options.logsDir = argv[++index];
        break;
      case "--stability-dir":
        options.stabilityDir = argv[++index];
        break;
      case "--logs-only":
        options.includeStability = false;
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        usage();
        process.exit(1);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const aggregated = aggregateRunTiming({
    logPaths: options.logPaths.filter(Boolean),
    stabilityPaths: options.stabilityPaths.filter(Boolean),
    agentJsonlPaths: options.agentJsonlPaths.filter(Boolean),
    monitorTracePaths: options.monitorTracePaths.filter(Boolean),
    logsDir: options.logsDir,
    stabilityDir: options.stabilityDir,
    runIdFilter: options.runId,
    includeStability: options.includeStability,
  });

  if (options.format === "tsv") {
    process.stdout.write(formatRunSummaryTsv(aggregated));
    return;
  }

  if (options.format === "events-tsv") {
    process.stdout.write(formatEventsTsv(aggregated));
    return;
  }

  if (options.format === "breakdown-tsv") {
    process.stdout.write(formatBreakdownTsv(aggregated));
    return;
  }

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(aggregated, null, 2)}\n`);
    return;
  }

  for (const event of aggregated.events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
