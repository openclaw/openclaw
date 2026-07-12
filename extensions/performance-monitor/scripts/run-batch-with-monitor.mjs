#!/usr/bin/env node
/**
 * Run N agent turns on a dev Gateway with performance-monitor, export traces, print breakdown TSV.
 *
 * Usage:
 *   node extensions/performance-monitor/scripts/run-batch-with-monitor.mjs --count=10
 *   SKIP_BUILD=1 node extensions/performance-monitor/scripts/run-batch-with-monitor.mjs --count=3
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateRunTiming,
  formatBreakdownTsv,
  formatEventsTsv,
  formatPerRunStageSummaryTsv,
  formatStageAverageTsv,
} from "./lib/aggregate-run-timing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const countArg = process.argv.find((a) => a.startsWith("--count="))?.slice(8);
const count = Number(countArg ?? "10");
const gatewayPort = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "18791");
const sessionKey = "agent:main:perf-batch-monitor";
const outDir = path.join(repoRoot, ".tmp/perf-batch-monitor");
const tracesPath = path.join(outDir, "monitor-traces.json");
const queriesPath = path.join(outDir, "queries.jsonl");

const DEFAULT_QUERIES = [
  "Reply with exactly: query-1-ok",
  "What is 17 + 25? Reply with the number only.",
  "Name one primary color. One word only.",
  "Is water wet? Reply yes or no only.",
  "Reply with exactly: query-5-pong",
  "What is the capital of France? One word only.",
  "Reply with exactly: query-7-ready",
  "How many days are in a week? Reply with digit only.",
  "Reply with exactly: query-9-done",
  "What is 8 times 7? Reply with the number only.",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

async function waitForHttp(url, headers, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return res.json();
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const userConfigPath = path.join(process.env.HOME ?? "", ".openclaw/openclaw.json");
  if (!fs.existsSync(userConfigPath)) {
    throw new Error(`Missing config: ${userConfigPath}`);
  }
  const userConfig = readJson(userConfigPath);
  const demoStateDir = path.join(outDir, "state");
  const demoConfigPath = path.join(demoStateDir, "openclaw.json");
  const gatewayToken = userConfig.gateway?.auth?.token ?? "perf-demo-token";

  const demoConfig = structuredClone(userConfig);
  demoConfig.diagnostics = { enabled: true, ...(demoConfig.diagnostics ?? {}) };
  demoConfig.gateway = {
    ...demoConfig.gateway,
    port: gatewayPort,
    mode: "local",
    bind: "loopback",
  };
  demoConfig.plugins = {
    ...demoConfig.plugins,
    entries: {
      ...demoConfig.plugins?.entries,
      "performance-monitor": { enabled: true, config: { logTimingEvents: true } },
    },
    load: { ...demoConfig.plugins?.load, paths: demoConfig.plugins?.load?.paths ?? [] },
  };
  delete demoConfig.plugins.load.paths;
  writeJson(demoConfigPath, demoConfig);

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: demoStateDir,
    OPENCLAW_CONFIG_PATH: demoConfigPath,
  };

  if (process.env.SKIP_BUILD !== "1") {
    console.error("Building OpenClaw...");
    const build = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", env });
    if (build.status !== 0) {
      throw new Error(`build failed: ${build.status}`);
    }
  }

  const queries = DEFAULT_QUERIES.slice(0, count);
  console.error(`Starting dev gateway on :${gatewayPort} for ${queries.length} queries...`);
  const gateway = spawn("pnpm", ["openclaw", "gateway", "run"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => process.stderr.write(chunk));
  gateway.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const shutdown = () => gateway.kill("SIGTERM");
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  const authHeaders = { Authorization: `Bearer ${gatewayToken}` };
  /** @type {Map<string, { queryIndex: number; query: string; wallMs?: number; agentDurationMs?: number }>} */
  const runMeta = new Map();
  const queryResults = [];

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, authHeaders);

    for (let i = 0; i < queries.length; i += 1) {
      const query = queries[i];
      console.error(`=== query ${i + 1}/${queries.length} ===`);
      console.error(query);
      const started = Date.now();
      const agent = spawnSync(
        "pnpm",
        [
          "openclaw",
          "agent",
          "--session-key",
          sessionKey,
          "--message",
          query,
          "--timeout",
          "180",
          "--json",
        ],
        { cwd: repoRoot, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const wallMs = Date.now() - started;
      if (agent.status !== 0) {
        console.error(agent.stderr?.slice(-1200));
        throw new Error(`agent query ${i + 1} failed: ${agent.status}`);
      }
      const parsed = JSON.parse(agent.stdout.trim());
      const agentDurationMs = parsed.result?.meta?.durationMs;
      runMeta.set(parsed.runId, {
        queryIndex: i + 1,
        query,
        wallMs,
        agentDurationMs,
      });
      queryResults.push({
        queryIndex: i + 1,
        query,
        runId: parsed.runId,
        wallMs,
        agentDurationMs,
        status: parsed.status,
        sessionKey: parsed.sessionKey,
        sessionId: parsed.sessionId,
      });
      console.error(
        `runId=${parsed.runId} wallMs=${wallMs} agentDurationMs=${agentDurationMs ?? "n/a"}`,
      );
    }

    writeText(queriesPath, `${queryResults.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const traces = [];
    for (const row of queryResults) {
      const trace = await (
        await fetch(
          `http://127.0.0.1:${gatewayPort}/api/performance-monitor/runs/${encodeURIComponent(row.runId)}`,
          { headers: authHeaders },
        )
      ).json();
      if (trace?.runId) {
        traces.push({ ...trace, queryIndex: row.queryIndex, query: row.query, wallMs: row.wallMs });
      }
    }

    writeJson(tracesPath, { runs: traces, queries: queryResults });
    console.error(`Wrote ${traces.length} traces -> ${tracesPath}`);

    const aggregated = aggregateRunTiming({
      monitorTracePaths: [tracesPath],
      includeStability: false,
    });

    const perRunStageSummary = formatPerRunStageSummaryTsv(aggregated, runMeta);
    const stageAverage = formatStageAverageTsv(aggregated);
    const breakdownTsv = formatBreakdownTsv(aggregated);
    const eventsTsv = formatEventsTsv(aggregated);

    writeText(path.join(outDir, "per-run-stage-summary.tsv"), perRunStageSummary);
    writeText(path.join(outDir, "stage-average.tsv"), stageAverage);
    writeText(path.join(outDir, "breakdown.tsv"), breakdownTsv);
    writeText(path.join(outDir, "events.tsv"), eventsTsv);

    console.log("=== per-run-stage-summary.tsv (each query × stage totals) ===");
    process.stdout.write(perRunStageSummary);
    console.log("=== stage-average.tsv (cross-query averages by stage/breakdown key) ===");
    process.stdout.write(stageAverage);
    console.log("=== breakdown.tsv (per runId × hook/tool/llm/phase detail) ===");
    process.stdout.write(breakdownTsv);
    console.log("=== events.tsv (each hook/tool/llm invocation) ===");
    process.stdout.write(eventsTsv);
    console.error(`Artifacts: ${outDir}`);
  } finally {
    shutdown();
  }
}

await main();
