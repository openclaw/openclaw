#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const STATE_PATH = path.join(
  ROOT,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-tradingagents-upstream-latest.json",
);
const VENDOR_DIR = path.join(ROOT, ".openclaw", "vendors", "TradingAgents");
const VENV_PYTHON = path.join(ROOT, ".openclaw", "venvs", "tradingagents", "Scripts", "python.exe");

const args = process.argv.slice(2);
const providerArg =
  valueAfter("--provider") || process.env.OPENCLAW_TRADINGAGENTS_PROVIDER || "ollama";
const modelArg = valueAfter("--model") || process.env.OPENCLAW_TRADINGAGENTS_MODEL || "qwen3:14b";
const allowBlocked = args.includes("--allow-blocked") || args.includes("--status");

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
}

function text(value) {
  return String(value ?? "").trim();
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.OPENCLAW_TRADINGAGENTS_PYTHON) {
    candidates.push({
      command: process.env.OPENCLAW_TRADINGAGENTS_PYTHON,
      args: [],
      source: "env",
    });
  }
  candidates.push({ command: VENV_PYTHON, args: [], source: "repo_venv" });
  candidates.push({ command: "python", args: [], source: "system_python" });
  candidates.push({ command: "py", args: ["-3"], source: "py_launcher" });
  return candidates;
}

function parseJson(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON returned");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function importProbe(candidate) {
  const probe = [
    "import json",
    "from tradingagents.graph.trading_graph import TradingAgentsGraph",
    "from tradingagents.default_config import DEFAULT_CONFIG",
    "print(json.dumps({'ok': True, 'config_keys': sorted(DEFAULT_CONFIG.keys())[:12]}))",
  ].join("; ");
  const result = run(candidate.command, [...candidate.args, "-c", probe]);
  if (result.status !== 0) {
    return {
      ok: false,
      source: candidate.source,
      command: candidate.command,
      args: candidate.args,
      error: result.error?.message ?? null,
      stderr: text(result.stderr),
      stdout: text(result.stdout),
    };
  }
  try {
    return {
      ok: true,
      source: candidate.source,
      command: candidate.command,
      args: candidate.args,
      result: parseJson(result.stdout),
    };
  } catch (error) {
    return {
      ok: false,
      source: candidate.source,
      command: candidate.command,
      args: candidate.args,
      stderr: error.message,
      stdout: text(result.stdout),
    };
  }
}

function providerCredentialProbe(provider) {
  const normalized = provider.toLowerCase();
  const envByProvider = {
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    xai: "XAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    "qwen-cn": "DASHSCOPE_CN_API_KEY",
    glm: "ZHIPU_API_KEY",
    "glm-cn": "ZHIPU_CN_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    azure: "AZURE_OPENAI_API_KEY",
  };
  if (normalized === "ollama") {
    return {
      ok: true,
      provider,
      credential: "not_required",
      note: "Ollama provider uses local or remote OLLAMA_BASE_URL.",
    };
  }
  const key = envByProvider[normalized];
  if (!key) {
    return { ok: false, provider, credential: "unknown_provider" };
  }
  return {
    ok: Boolean(process.env[key]),
    provider,
    credential: key,
    redacted: process.env[key] ? "***set***" : "",
  };
}

const vendorExists = await exists(VENDOR_DIR);
const probes = pythonCandidates().map(importProbe);
const activeImport = probes.find((probe) => probe.ok) ?? null;
const credential = providerCredentialProbe(providerArg);
const blockers = [];

if (!vendorExists) {
  blockers.push(".openclaw/vendors/TradingAgents is not installed");
}
if (!activeImport) {
  blockers.push("Python cannot import tradingagents");
}
if (!credential.ok) {
  blockers.push(`provider credential is not ready for ${providerArg}`);
}

const report = {
  schema: "openclaw.tradingagents.upstream-readiness.v1",
  generatedAt: new Date().toISOString(),
  status: blockers.length === 0 ? "pass" : "blocked",
  statusMode: allowBlocked ? "report_only" : "gate",
  provider: providerArg,
  model: modelArg,
  vendor: {
    path: path.relative(ROOT, VENDOR_DIR),
    exists: vendorExists,
  },
  import: {
    ok: Boolean(activeImport),
    active: activeImport,
    probes,
  },
  credential,
  canStartUpstreamBridge: blockers.length === 0,
  no_live_order_sent: true,
  brokerWriteAttempted: false,
  remainingBlockers: blockers,
  nextCommand:
    blockers.length === 0
      ? `.openclaw\\venvs\\tradingagents\\Scripts\\python.exe scripts\\tradingagents-bridge\\server.py --provider ${providerArg} --model ${modelArg} --strict-upstream`
      : "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\tradingagents-bridge\\install.ps1",
};

await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
await fs.writeFile(STATE_PATH, JSON.stringify(report, null, 2), "utf-8");
console.log(JSON.stringify(report, null, 2));

if (blockers.length > 0 && !allowBlocked) {
  process.exitCode = 1;
}
