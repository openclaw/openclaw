#!/usr/bin/env node
import { spawn } from "node:child_process";
/**
 * Demo: simulate one user turn and print performance-monitor breakdown.
 *
 * Usage:
 *   node extensions/performance-monitor/scripts/demo-user-turn.mjs --simulate
 *   node extensions/performance-monitor/scripts/demo-user-turn.mjs --live
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const perfExtRoot = path.join(repoRoot, "extensions/performance-monitor");
const mode = process.argv.includes("--live") ? "live" : "simulate";
const userMessage =
  process.argv.find((arg) => arg.startsWith("--message="))?.slice("--message=".length) ??
  "请读取 workspace 里的 README.md，用一句话总结，并列出当前目录前 3 个文件名。";

function printReport(title, payload) {
  console.log(`\n=== ${title} ===\n`);
  for (const run of payload.runs ?? [payload]) {
    const breakdown = run.breakdown ?? payload.breakdown;
    const summary = run.summary ?? payload.summary;
    console.log(`runId: ${run.runId}`);
    console.log(`outcome: ${run.outcome ?? "n/a"}`);
    console.log(`totalDurationMs: ${run.totalDurationMs ?? "n/a"}`);
    console.log(
      `summary: hooks=${summary.totalHookHandlerMs}ms (${summary.hookHandlerCount}), tools=${summary.totalToolMs}ms (${summary.toolCallCount}), llm=${summary.totalLlmMs}ms (${summary.llmCallCount}), phases=${summary.totalPhaseMs}ms (${summary.phaseCount})`,
    );
    if (!breakdown) {
      continue;
    }
    console.log("\n-- categoryTotals --");
    console.log(JSON.stringify(breakdown.categoryTotals, null, 2));
    for (const section of [
      ["phases", "环节"],
      ["hookHandlers", "插件 Hook"],
      ["tools", "工具调用"],
      ["llmCalls", "模型调用"],
      ["byExtension", "按插件汇总"],
    ]) {
      const [key, label] = section;
      const rows = breakdown[key] ?? [];
      if (rows.length === 0) {
        continue;
      }
      console.log(`\n-- ${label} (${key}) --`);
      for (const row of rows.slice(0, 12)) {
        console.log(
          `  ${row.label}: total=${row.totalMs}ms count=${row.count} avg=${row.avgMs}ms max=${row.maxMs}ms${row.errorCount ? ` errors=${row.errorCount}` : ""}`,
        );
      }
    }
  }
}

async function runSimulate() {
  const monitorMod = await import(pathToFileURL(path.join(perfExtRoot, "src/monitor.ts")).href);
  const serviceMod = await import(pathToFileURL(path.join(perfExtRoot, "src/service.ts")).href);
  const { createPerformanceMonitorService, testApi } = serviceMod;
  const { monitor } = createPerformanceMonitorService({ maxRuns: 20, maxEventsPerRun: 500 });
  const runId = "demo-run-001";
  const trusted = Object.freeze({ trusted: true });
  const ts = Date.now();

  const emit = (event) => testApi.recordDiagnosticEvent(monitor, event);

  emit({ type: "run.started", seq: 1, ts, runId, sessionKey: "agent:main:perf-demo" });
  emit({
    type: "diagnostic.phase.completed",
    seq: 2,
    ts: ts + 10,
    runId,
    name: "session_prepare",
    startedAt: ts + 5,
    endedAt: ts + 45,
    durationMs: 40,
  });
  emit({
    type: "hook.handler.completed",
    seq: 3,
    ts: ts + 50,
    runId,
    pluginId: "session-memory",
    hookName: "before_prompt_build",
    durationMs: 28,
    outcome: "completed",
  });
  emit({
    type: "hook.handler.completed",
    seq: 4,
    ts: ts + 80,
    runId,
    pluginId: "boot-md",
    hookName: "before_agent_start",
    durationMs: 12,
    outcome: "completed",
  });
  emit({
    type: "diagnostic.phase.completed",
    seq: 5,
    ts: ts + 100,
    runId,
    name: "prompt_build",
    startedAt: ts + 60,
    endedAt: ts + 180,
    durationMs: 120,
  });
  emit({
    type: "model.call.completed",
    seq: 6,
    ts: ts + 200,
    runId,
    callId: `${runId}:model:1`,
    provider: "custom-models-proxy-stepfun-inc-com",
    model: "deepseek-v4-pro-aliyun",
    providerPluginId: "openai",
    api: "openai-completions",
    durationMs: 1800,
  });
  emit({
    type: "tool.execution.completed",
    seq: 7,
    ts: ts + 2100,
    runId,
    toolName: "read",
    toolSource: "core",
    handlerName: "read",
    handlerRef: "core:read",
    durationMs: 35,
    toolCallId: "tool-1",
  });
  emit({
    type: "hook.handler.completed",
    seq: 8,
    ts: ts + 2140,
    runId,
    pluginId: "feishu",
    hookName: "after_tool_call",
    durationMs: 8,
    outcome: "completed",
  });
  emit({
    type: "tool.execution.completed",
    seq: 9,
    ts: ts + 2200,
    runId,
    toolName: "list",
    toolSource: "core",
    handlerName: "list",
    handlerRef: "core:list",
    durationMs: 22,
    toolCallId: "tool-2",
  });
  emit({
    type: "model.call.completed",
    seq: 10,
    ts: ts + 2300,
    runId,
    callId: `${runId}:model:2`,
    provider: "custom-models-proxy-stepfun-inc-com",
    model: "deepseek-v4-pro-aliyun",
    providerPluginId: "openai",
    api: "openai-completions",
    durationMs: 950,
  });
  emit({
    type: "hook.handler.completed",
    seq: 11,
    ts: ts + 3260,
    runId,
    pluginId: "command-logger",
    hookName: "before_agent_reply",
    durationMs: 5,
    outcome: "completed",
  });
  emit({
    type: "run.completed",
    seq: 12,
    ts: ts + 3300,
    runId,
    durationMs: 3300,
    outcome: "completed",
  });

  printReport(`模拟用户输入: "${userMessage}"`, monitor.getRunTrace(runId));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForHttp(url, headers, timeoutMs = 120_000) {
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

async function runLive() {
  const userConfigPath = path.join(process.env.HOME ?? "", ".openclaw/openclaw.json");
  if (!fs.existsSync(userConfigPath)) {
    throw new Error(`Missing config: ${userConfigPath}`);
  }
  const userConfig = readJson(userConfigPath);
  const demoStateDir = path.join(repoRoot, ".tmp/perf-demo-state");
  const demoConfigPath = path.join(demoStateDir, "openclaw.json");
  const gatewayPort = 18790;
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
    load: {
      ...demoConfig.plugins?.load,
      paths: demoConfig.plugins?.load?.paths ?? [],
    },
  };
  // Bundled dev checkout already exposes performance-monitor; avoid redundant load.paths.
  delete demoConfig.plugins.load.paths;
  writeJson(demoConfigPath, demoConfig);

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: demoStateDir,
    OPENCLAW_CONFIG_PATH: demoConfigPath,
  };

  console.log("Building OpenClaw (required for hook diagnostics)...");
  if (!process.env.SKIP_BUILD) {
    await new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", env });
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`build exit ${code}`)),
      );
    });
  }

  console.log(`Starting gateway on :${gatewayPort}...`);
  const gateway = spawn("pnpm", ["openclaw", "gateway", "run"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => process.stderr.write(chunk));
  gateway.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const shutdown = () => {
    gateway.kill("SIGTERM");
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, {
      Authorization: `Bearer ${gatewayToken}`,
    });

    console.log(`Sending user message: ${userMessage}`);
    await new Promise((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "openclaw",
          "agent",
          "--session-key",
          "perf-demo",
          "--message",
          userMessage,
          "--timeout",
          "180",
        ],
        { cwd: repoRoot, env, stdio: "inherit" },
      );
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`agent exit ${code}`)),
      );
    });

    const report = await waitForHttp(
      `http://127.0.0.1:${gatewayPort}/api/performance-monitor/report`,
      { Authorization: `Bearer ${gatewayToken}` },
    );
    const latest = report.runs?.at(-1);
    if (!latest) {
      throw new Error("performance-monitor report is empty; ensure diagnostics.enabled=true");
    }
    const trace = await (
      await fetch(
        `http://127.0.0.1:${gatewayPort}/api/performance-monitor/runs/${encodeURIComponent(latest.runId)}`,
        { headers: { Authorization: `Bearer ${gatewayToken}` } },
      )
    ).json();
    printReport(`Live 用户输入: "${userMessage}"`, trace);
  } finally {
    shutdown();
  }
}

if (mode === "live") {
  await runLive();
} else {
  await runSimulate();
}
