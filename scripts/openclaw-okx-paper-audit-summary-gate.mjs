import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(STATE_DIR, "openclaw-okx-paper-audit-summary-latest.json");
const DEFAULT_AUDIT_LOG_PATH = path.join(STATE_DIR, "openclaw-okx-paper-audit-log.jsonl");

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function increment(map, key) {
  const safeKey = String(key || "unknown");
  map[safeKey] = (map[safeKey] || 0) + 1;
}

function readBool(value) {
  return value === true;
}

function compactLatestEntry(entry) {
  const result = entry?.result ?? {};
  return {
    ts: String(entry?.ts || ""),
    provider: String(entry?.provider || ""),
    eventType: String(entry?.eventType || ""),
    sourceReport: String(entry?.sourceReport || ""),
    sourceDigest: String(entry?.sourceDigest || ""),
    status: String(entry?.status || ""),
    code: String(entry?.code || ""),
    result: {
      profile: String(result.profile || ""),
      instId: String(result.instId || ""),
      simulationCode: String(result.simulationCode || ""),
      simulationStatus: String(result.simulationStatus || ""),
      simulatedClientOrderId: String(result.simulatedClientOrderId || ""),
      exchangeOrderId: String(result.exchangeOrderId || ""),
      orderStatus: String(result.orderStatus || ""),
      fillStatus: String(result.fillStatus || ""),
      cancelStatus: String(result.cancelStatus || ""),
    },
  };
}

function summarizeEntries(entries) {
  const byEventType = {};
  const byStatus = {};
  const byCode = {};
  const safetyCounts = {
    submittedOrder: 0,
    exchangeWriteAttempted: 0,
    orderStatusQueryExecuted: 0,
    cancelSubmitted: 0,
    exchangeCancelAttempted: 0,
    liveTradingEnabled: 0,
    writeTradingEnabled: 0,
    credentialEchoed: 0,
    storesSecretsInRepo: 0,
  };
  for (const entry of entries) {
    increment(byEventType, entry.eventType);
    increment(byStatus, entry.status);
    increment(byCode, entry.code);
    const safety = entry.safety ?? {};
    for (const key of Object.keys(safetyCounts)) {
      if (readBool(safety[key])) {
        safetyCounts[key] += 1;
      }
    }
  }
  return {
    byEventType,
    byStatus,
    byCode,
    safetyCounts,
  };
}

async function readAuditLog(filePath) {
  if (!(await pathExists(filePath))) {
    return {
      exists: false,
      rawDigest: "",
      entries: [],
      invalidLines: [],
      lineCount: 0,
    };
  }
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const entries = [];
  const invalidLines = [];
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line);
      entries.push(parsed);
    } catch {
      invalidLines.push(index + 1);
    }
  }
  return {
    exists: true,
    rawDigest: sha256Text(raw),
    entries,
    invalidLines,
    lineCount: lines.length,
  };
}

function buildBlockers({ auditLog, safetyCounts }) {
  const blockers = [];
  if (!auditLog.exists) {
    blockers.push("audit_log_missing");
  }
  if (auditLog.invalidLines.length > 0) {
    blockers.push("audit_log_invalid_json");
  }
  if (auditLog.entries.length === 0) {
    blockers.push("audit_log_empty");
  }
  for (const [key, count] of Object.entries(safetyCounts)) {
    if (count > 0) {
      blockers.push(`unsafe_${key}`);
    }
  }
  return unique(blockers);
}

export async function buildOkxPaperAuditSummaryGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const auditLogPath = path.resolve(options.auditLogPath || DEFAULT_AUDIT_LOG_PATH);
  const auditLog = await readAuditLog(auditLogPath);
  const summary = summarizeEntries(auditLog.entries);
  const blockers = buildBlockers({ auditLog, safetyCounts: summary.safetyCounts });
  const ready = blockers.length === 0;
  const latestEntry = auditLog.entries.at(-1) ?? null;

  return {
    schema: "openclaw.okx.paper-audit-summary-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "read_only_paper_audit_summary",
    status: ready ? "ready_read_only" : "blocked",
    code: ready ? "paper_audit_summary_ready" : "paper_audit_summary_blocked",
    summary_zh_tw: ready
      ? `OKX paper audit summary 可讀：共 ${auditLog.entries.length} 筆，未發現送單、查單、撤單或憑證外洩。`
      : `OKX paper audit summary 阻擋：${blockers.join("、")}。`,
    blockers,
    markers: unique([
      ready ? "paper_audit_summary_ready" : "paper_audit_summary_blocked",
      "read_only_audit_summary",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
      ...blockers,
    ]),
    auditLog: {
      path: repoRelative(auditLogPath),
      format: "jsonl",
      exists: auditLog.exists,
      rawDigest: auditLog.rawDigest,
      lineCount: auditLog.lineCount,
      parsedEntries: auditLog.entries.length,
      invalidLineCount: auditLog.invalidLines.length,
      invalidLines: auditLog.invalidLines,
    },
    counts: {
      totalEntries: auditLog.entries.length,
      byEventType: summary.byEventType,
      byStatus: summary.byStatus,
      byCode: summary.byCode,
    },
    latestEntry: latestEntry ? compactLatestEntry(latestEntry) : null,
    safetyAggregate: {
      ...summary.safetyCounts,
      allEntriesSafe: Object.values(summary.safetyCounts).every((count) => count === 0),
    },
    safety: {
      paperOnly: true,
      demoOnly: true,
      readOnly: true,
      auditOnly: true,
      summaryOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      amendOrderEnabled: false,
      withdrawalEnabled: false,
      credentialEchoed: false,
      storesSecretsInRepo: false,
    },
    commands: {
      executed: ["read local OpenClaw OKX paper audit JSONL"],
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:paper-audit-summary and okx:paper-audit-summary:check.",
      "Delete scripts/openclaw-okx-paper-audit-summary-gate.mjs and scripts/check-openclaw-okx-paper-audit-summary-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json and .sha256.",
      "Remove OKX paper-audit-summary references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask: ready
      ? "把 OKX paper audit summary 接到 Telegram/assistant status read-only 面板。"
      : "先修復 paper audit summary blocker，再重跑 okx:paper-audit-summary:check。",
  };
}

async function main() {
  const report = await buildOkxPaperAuditSummaryGate({
    auditLogPath: argValue("--audit-log", DEFAULT_AUDIT_LOG_PATH),
  });
  const outputPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(outputPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.summary_zh_tw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `okx paper audit summary gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
