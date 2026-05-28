import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkxDemoOrderSimulationResultGate } from "./openclaw-okx-demo-order-simulation-result-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(STATE_DIR, "openclaw-okx-paper-audit-log-latest.json");
const DEFAULT_AUDIT_LOG_PATH = path.join(STATE_DIR, "openclaw-okx-paper-audit-log.jsonl");
const DEMO_SIMULATION_REPORT_PATH =
  "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json";
const DEFAULT_INST_ID = "BTC-USDT";

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

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value)}\n`;
  await fs.appendFile(filePath, payload, "utf8");
  return {
    bytesWritten: Buffer.byteLength(payload, "utf8"),
    entryDigest: sha256Text(payload),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildBlockers(simulationResult) {
  const blockers = [];
  const safety = simulationResult.safety ?? {};
  if (simulationResult.schema !== "openclaw.okx.demo-order-simulation-result-gate.v1") {
    blockers.push("demo_simulation_result_schema_blocked");
  }
  if (simulationResult.status !== "ready_no_exchange_write") {
    blockers.push("demo_simulation_result_not_ready");
  }
  if (safety.submittedOrder !== false) {
    blockers.push("submitted_order_not_false");
  }
  if (safety.exchangeWriteAttempted !== false) {
    blockers.push("exchange_write_attempted");
  }
  if (safety.orderStatusQueryExecuted !== false) {
    blockers.push("order_status_query_executed");
  }
  if (safety.cancelSubmitted !== false || safety.exchangeCancelAttempted !== false) {
    blockers.push("cancel_attempted");
  }
  if (safety.liveTradingEnabled !== false || safety.writeTradingEnabled !== false) {
    blockers.push("live_or_write_enabled");
  }
  if (safety.credentialEchoed !== false || safety.storesSecretsInRepo !== false) {
    blockers.push("credential_safety_unknown");
  }
  return unique(blockers);
}

function buildAuditEntry({ generatedAt, simulationResult }) {
  const sourcePayload = `${JSON.stringify(simulationResult, null, 2)}\n`;
  return {
    schema: "openclaw.okx.paper-audit-entry.v1",
    ts: generatedAt,
    provider: "okx",
    eventType: "okx.demo_order_simulation_result",
    sourceReport: DEMO_SIMULATION_REPORT_PATH,
    sourceDigest: sha256Text(sourcePayload),
    status: simulationResult.status,
    code: simulationResult.code,
    result: simulationResult.result,
    safety: {
      demoOnly: true,
      readOnly: true,
      dryRunOnly: true,
      auditOnly: true,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      credentialEchoed: false,
      storesSecretsInRepo: false,
    },
  };
}

export async function buildOkxPaperAuditLogGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const instId = options.instId || DEFAULT_INST_ID;
  const auditLogPath = path.resolve(options.auditLogPath || DEFAULT_AUDIT_LOG_PATH);
  const simulationResult = await buildOkxDemoOrderSimulationResultGate({
    instId,
    now: options.now,
  });
  const blockers = buildBlockers(simulationResult);
  const ready = blockers.length === 0;
  const auditEntry = buildAuditEntry({ generatedAt, simulationResult });
  const appendResult =
    ready && options.appendAudit === true
      ? await appendJsonLine(auditLogPath, auditEntry)
      : { bytesWritten: 0, entryDigest: sha256Text(`${JSON.stringify(auditEntry)}\n`) };

  return {
    schema: "openclaw.okx.paper-audit-log-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "append_only_paper_audit_log",
    status: ready ? "ready_append_only" : "blocked",
    code: ready ? "paper_audit_log_ready" : "paper_audit_log_blocked",
    summary_zh_tw: ready
      ? "OKX paper audit log 已接上 demo-only 模擬結果；仍未送單、查單或撤單。"
      : `OKX paper audit log 阻擋：${blockers.join("、")}。`,
    blockers,
    markers: unique([
      ready ? "paper_audit_log_ready" : "paper_audit_log_blocked",
      "append_only_audit",
      "demo_only",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
      ...blockers,
    ]),
    dependsOn: {
      demoSimulationResultGate: DEMO_SIMULATION_REPORT_PATH,
      demoSimulationResultSchema: simulationResult.schema,
      demoSimulationResultGeneratedAt: simulationResult.generatedAt,
      demoSimulationResultCode: simulationResult.code,
    },
    auditLog: {
      path: repoRelative(auditLogPath),
      format: "jsonl",
      appended: ready && options.appendAudit === true,
      bytesWritten: appendResult.bytesWritten,
      entryDigest: appendResult.entryDigest,
      entrySchema: auditEntry.schema,
      eventType: auditEntry.eventType,
    },
    latestEntry: auditEntry,
    safety: {
      paperOnly: true,
      demoOnly: true,
      readOnly: true,
      dryRunOnly: true,
      auditOnly: true,
      appendOnly: true,
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
      executed: unique([
        "okx demo simulation result gate dependency",
        options.appendAudit === true
          ? "append local OpenClaw OKX paper audit JSONL"
          : "build audit log report only",
      ]),
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
      "Remove package scripts okx:paper-audit-log and okx:paper-audit-log:check.",
      "Delete scripts/openclaw-okx-paper-audit-log-gate.mjs and scripts/check-openclaw-okx-paper-audit-log-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json and .sha256.",
      "Delete reports/hermes-agent/state/openclaw-okx-paper-audit-log.jsonl if the audit history should be discarded.",
      "Remove OKX paper-audit references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask: ready
      ? "建立 OKX paper audit summary gate，統計最新 audit log 並保持 read-only。"
      : "先修復 paper audit blocker，再重跑 okx:paper-audit-log:check。",
  };
}

async function main() {
  const report = await buildOkxPaperAuditLogGate({
    instId: argValue("--inst-id", DEFAULT_INST_ID),
    auditLogPath: argValue("--audit-log", DEFAULT_AUDIT_LOG_PATH),
    appendAudit: hasFlag("--write-state"),
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
      `okx paper audit log gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
