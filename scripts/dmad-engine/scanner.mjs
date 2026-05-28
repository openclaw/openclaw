#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const STATE_DIR = path.join(ROOT, "reports", "hermes-agent", "state");
const CONFIG_PATH = path.join(ROOT, ".openclaw", "dmad", "config", "dmad-loop-config.json");

const defaultGates = [
  {
    id: "live-readiness",
    check: "capital:live-readiness:check",
    stateFile: "reports/hermes-agent/state/openclaw-capital-live-readiness-gate-latest.json",
  },
  {
    id: "strategy-fill",
    check: "capital:strategy:fill-simulation:check",
    stateFile: ".openclaw/trading/capital-strategy-fill-simulation.json",
  },
  {
    id: "adapter-ack",
    check: "capital:trade:adapter-ack:check",
    stateFile: ".openclaw/trading/capital-external-broker-adapter-ack-gate.json",
  },
  {
    id: "arm-profile",
    check: "capital:trade:live-executor-profile:check",
    stateFile: "reports/hermes-agent/state/openclaw-capital-live-executor-arm-profile-latest.json",
  },
];

function normalizeGateId(script) {
  return String(script ?? "unknown")
    .replaceAll(":", "-")
    .replaceAll("/", "-");
}

function runCheckScript(script, timeoutMs = 30_000) {
  if (!script) return null;
  try {
    execSync(`pnpm --dir "${ROOT}" ${script}`, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return null;
  } catch (error) {
    const stderr = [
      error?.stdout ? String(error.stdout) : "",
      error?.stderr ? String(error.stderr) : "",
      error?.message ? String(error.message) : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
    return stderr.length > 0 ? stderr.slice(0, 1500) : `check_failed:${script}`;
  }
}

async function loadConfigGates() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const gates = Array.isArray(parsed?.diagnosis?.gates)
      ? parsed.diagnosis.gates
          .filter((gate) => typeof gate?.script === "string" && typeof gate?.stateFile === "string")
          .map((gate) => ({
            id: gate.id || normalizeGateId(gate.script),
            check: gate.script,
            stateFile: gate.stateFile,
          }))
      : [];
    return gates.length > 0 ? gates : defaultGates;
  } catch {
    return defaultGates;
  }
}

async function readJsonState(stateFile) {
  const fullPath = path.isAbsolute(stateFile) ? stateFile : path.join(ROOT, stateFile);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectStateBlockers(state) {
  if (!state || typeof state !== "object") return [];
  const blockers = new Set();
  const candidateArrays = [
    Array.isArray(state.blockers) ? state.blockers : [],
    Array.isArray(state?.promotionGate?.blockedReasons) ? state.promotionGate.blockedReasons : [],
    Array.isArray(state?.validation?.blockedReasons) ? state.validation.blockedReasons : [],
  ];
  for (const items of candidateArrays) {
    for (const item of items) {
      const normalized = String(item ?? "").trim();
      if (normalized.length > 0) blockers.add(normalized);
    }
  }
  const status = String(state.status ?? "").toLowerCase();
  const recommendation = String(state.recommendation ?? "").toLowerCase();
  if (blockers.size === 0 && ["blocked", "fail", "failed", "error"].includes(status)) {
    blockers.add(`status:${status}`);
  }
  if (blockers.size === 0 && ["hold", "blocked"].includes(recommendation)) {
    blockers.add(`recommendation:${recommendation}`);
  }
  return [...blockers];
}

function extractEvidence(state, blocker) {
  if (!state || typeof state !== "object") return {};
  if (String(blocker).includes("tail_risk_positive")) {
    return {
      p05: state?.monteCarlo?.p05_total_pnl_pts ?? null,
      p50: state?.monteCarlo?.p50_total_pnl_pts ?? null,
      stopHitRate: state?.empiricalTailEvidence?.outcomeStats?.stopHitRate ?? null,
      sampleCount: state?.empiricalTailEvidence?.outcomeStats?.sampleCount ?? null,
      intentsCount: state?.stats?.total_intents ?? null,
      winRate: state?.stats?.win_rate ?? null,
    };
  }
  if (String(blocker).includes("ack")) {
    return {
      expected: state?.sealedIntentSha256 ?? null,
      actual: state?.ack?.currentValue?.sealedIntentSha256 ?? null,
      hashOk: state?.ack?.hashOk ?? null,
    };
  }
  return {
    status: state.status ?? null,
    recommendation: state.recommendation ?? null,
    ready: state.ready ?? null,
  };
}

function summarizeState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    status: state.status ?? null,
    recommendation: state.recommendation ?? null,
    blockers: state.blockers ?? state?.promotionGate?.blockedReasons ?? [],
    p05: state?.monteCarlo?.p05_total_pnl_pts ?? null,
    ready: state.ready ?? null,
  };
}

async function scanServiceStatus() {
  try {
    const response = await fetch("http://localhost:8765/api/status");
    const status = await response.json();
    const blockers = [];
    if (status?.loginStatus !== "connected") blockers.push("login_not_connected");
    if (status?.orderInitialized !== true) blockers.push("order_not_initialized");
    if (status?.quoteMonitorConnected !== true) blockers.push("quote_not_connected");
    const allowLiveTrading = status?.riskControls?.allowLiveTrading;
    const writeBrokerOrders = status?.riskControls?.writeBrokerOrders;
    if (allowLiveTrading !== true) blockers.push("allow_live_trading_disabled");
    if (writeBrokerOrders !== true) blockers.push("write_broker_orders_disabled");
    return { blockers, stateSnapshot: summarizeState(status), evidence: status };
  } catch (error) {
    return {
      blockers: ["service_unreachable"],
      stateSnapshot: null,
      evidence: { errorMessage: String(error?.message ?? error) },
    };
  }
}

export async function scan() {
  const diagnoses = [];
  const now = new Date().toISOString();
  const gates = await loadConfigGates();

  for (const gate of gates) {
    const checkError = runCheckScript(gate.check);
    const state = await readJsonState(gate.stateFile);
    const blockers = collectStateBlockers(state);
    if (blockers.length === 0 && checkError) {
      blockers.push(`check_failed:${gate.check}`);
    }
    for (const blocker of blockers) {
      diagnoses.push({
        schema: "openclaw.dmad.diagnosis.v2",
        id: `${gate.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        discoveredAt: now,
        source: "dmad-scanner",
        gateId: gate.id,
        blocker,
        severity: blocker.includes("service") ? "critical" : "warning",
        evidence: {
          ...extractEvidence(state, blocker),
          gateScript: gate.check,
          stateFile: gate.stateFile,
          errorMessage: checkError,
        },
        stateSnapshot: summarizeState(state),
      });
    }
  }

  const service = await scanServiceStatus();
  for (const blocker of service.blockers) {
    diagnoses.push({
      schema: "openclaw.dmad.diagnosis.v2",
      id: `service-status-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      discoveredAt: now,
      source: "dmad-scanner",
      gateId: "service-status",
      blocker,
      severity: ["service_unreachable", "login_not_connected"].includes(blocker)
        ? "critical"
        : "warning",
      evidence: service.evidence,
      stateSnapshot: service.stateSnapshot,
    });
  }

  return diagnoses;
}

async function main() {
  const diagnoses = await scan();
  process.stdout.write(`${JSON.stringify(diagnoses, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === __filename) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
