#!/usr/bin/env node
/**
 * Run N agent turns on a dev Gateway with performance-monitor, export traces, print breakdown TSV.
 *
 * Usage:
 *   node extensions/performance-monitor/scripts/run-batch-with-monitor.mjs --count 10
 *   SKIP_BUILD=1 node extensions/performance-monitor/scripts/run-batch-with-monitor.mjs --count 3
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateRunTiming,
  formatBreakdownTsv,
  formatEventsTsv,
} from "./lib/aggregate-run-timing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const count = Number(process.argv.find((a) => a.startsWith("--count="))?.slice(8) ?? "10");
const gatewayPort = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "18791");
const sessionKey = "agent:main:perf-batch-monitor";
const outDir = path.join(repoRoot, ".tmp/perf-batch-monitor");
const tracesPath = path.join(outDir, "monitor-traces.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
      "performance-monitor": { enabled: true },
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

  console.error(`Starting dev gateway on :${gatewayPort}...`);
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
  const runIds = [];

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, authHeaders);

    for (let i = 1; i <= count; i += 1) {
      console.error(`=== query ${i}/${count} ===`);
      const agent = spawnSync(
        "pnpm",
        [
          "openclaw",
          "agent",
          "--session-key",
          sessionKey,
          "--message",
          `List only the filename README.md if it exists, else reply ok-${i}`,
          "--timeout",
          "120",
          "--json",
        ],
        { cwd: repoRoot, env, encoding: "utf8" },
      );
      if (agent.status !== 0) {
        console.error(agent.stderr?.slice(-800));
        throw new Error(`agent query ${i} failed: ${agent.status}`);
      }
      const parsed = JSON.parse(agent.stdout.trim());
      runIds.push(parsed.runId);
      console.error(`runId=${parsed.runId} durationMs=${parsed.result?.meta?.durationMs}`);
    }

    const traces = [];
    for (const runId of runIds) {
      const trace = await (
        await fetch(
          `http://127.0.0.1:${gatewayPort}/api/performance-monitor/runs/${encodeURIComponent(runId)}`,
          { headers: authHeaders },
        )
      ).json();
      if (trace?.runId) {
        traces.push(trace);
      }
    }

    writeJson(tracesPath, { runs: traces });
    console.error(`Wrote ${traces.length} traces -> ${tracesPath}`);

    const aggregated = aggregateRunTiming({
      monitorTracePaths: [tracesPath],
      includeStability: false,
    });
    console.log("=== breakdown-tsv (per runId × hook/tool/llm) ===");
    process.stdout.write(formatBreakdownTsv(aggregated));
    console.log("=== events-tsv (each hook/tool/llm invocation) ===");
    process.stdout.write(formatEventsTsv(aggregated));
  } finally {
    shutdown();
  }
}

await main();
