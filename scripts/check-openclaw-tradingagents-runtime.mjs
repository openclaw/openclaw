#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const STATE_PATH = path.join(
  ROOT,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-tradingagents-runtime-latest.json",
);

const args = process.argv.slice(2);
const allowStopped = args.includes("--allow-stopped") || args.includes("--status");
const port = Number(valueAfter("--port") ?? process.env.OPENCLAW_TRADINGAGENTS_PORT ?? 8390);
const host = valueAfter("--host") ?? process.env.OPENCLAW_TRADINGAGENTS_HOST ?? "127.0.0.1";

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`timeout from ${url}`));
    });
    req.on("error", reject);
  });
}

function findWindowsListener() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1`,
    "if ($conn) {",
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"',
    "  [pscustomobject]@{",
    "    pid = $conn.OwningProcess",
    "    localAddress = $conn.LocalAddress",
    "    localPort = $conn.LocalPort",
    "    commandLine = $proc.CommandLine",
    "  } | ConvertTo-Json -Depth 6",
    "}",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  const text = String(result.stdout ?? "").trim();
  if (!text) {
    return findNetstatListener();
  }
  try {
    return JSON.parse(text);
  } catch {
    return findNetstatListener();
  }
}

function findNetstatListener() {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  const lines = String(result.stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("LISTENING")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const local = parts[1] ?? "";
    if (!local.endsWith(`:${port}`)) {
      continue;
    }
    return {
      pid: Number(parts[4]),
      localAddress: local,
      source: "netstat",
    };
  }
  return null;
}

const blockers = [];
let health = null;
let runtimeError = null;

try {
  const response = await getJson(`http://${host}:${port}/health`);
  health = response.body;
  if (response.statusCode !== 200) {
    blockers.push(`health HTTP status is ${response.statusCode}`);
  }
} catch (error) {
  runtimeError = error.message;
  blockers.push(`bridge runtime is not reachable on ${host}:${port}: ${error.message}`);
}

if (health) {
  if (health.status !== "ok") {
    blockers.push(`health status is ${health.status}`);
  }
  if (health.mode !== "paper_signal_only") {
    blockers.push("mode is not paper_signal_only");
  }
  if (health.noOrderWrite !== true) {
    blockers.push("noOrderWrite is not true");
  }
  if (health.brokerWriteAttempted !== false) {
    blockers.push("brokerWriteAttempted is not false");
  }
  if (health.allowLiveTrading !== false) {
    blockers.push("allowLiveTrading is not false");
  }
  if (health.writeBrokerOrders !== false) {
    blockers.push("writeBrokerOrders is not false");
  }
}

const report = {
  schema: "openclaw.tradingagents.runtime.check.v1",
  generatedAt: new Date().toISOString(),
  status: blockers.length === 0 ? "ok" : allowStopped ? "blocked_report_only" : "blocked",
  host,
  port,
  health,
  listener: findWindowsListener(),
  runtimeError,
  no_live_order_sent: true,
  brokerWriteAttempted: false,
  remainingBlockers: blockers,
};

await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
await fs.writeFile(STATE_PATH, JSON.stringify(report, null, 2), "utf-8");
console.log(JSON.stringify(report, null, 2));

if (blockers.length > 0 && !allowStopped) {
  process.exitCode = 1;
}
