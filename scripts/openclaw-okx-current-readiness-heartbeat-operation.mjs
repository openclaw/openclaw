import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-current-readiness-heartbeat-operation-latest.json",
);
const CURRENT_READINESS_REPORT =
  "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json";
const REFRESH_WORKFLOW_REPORT =
  "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json";
const TELEGRAM_TRADING_SHORTCUTS_REPORT =
  "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json";
const TELEGRAM_PUBLISH_BRIDGE_STATUS_REPORT =
  "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-bridge-latest.json";
const REFRESH_COMMAND = "pnpm okx:current-readiness:refresh";
export const OKX_HEARTBEAT_READ_ONLY_ENV_LOCKS = Object.freeze({
  OPENCLAW_OKX_HEARTBEAT_OPERATION: "1",
  OPENCLAW_OKX_PRIVATE_ORDER_QUERY_ENABLED: "0",
  OPENCLAW_OKX_ORDER_WRITE_ENABLED: "0",
  OPENCLAW_OKX_CANCEL_ENABLED: "0",
  OPENCLAW_OKX_WITHDRAWAL_ENABLED: "0",
});
export const OKX_HEARTBEAT_NEXT_SAFE_TASK =
  "把 OKX合約 upstream bridge count 與 schedulerNextRunAt 接到 controlled-runner dmad_publish_status readback；仍保持 dry-run/noOrderWrite=true。";

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

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isTrue(value) {
  return value === true;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=-]+$/u.test(text) ? text : `"${text.replaceAll('"', '""')}"`;
}

function spawnSpec(bin, args) {
  if (process.platform === "win32" && bin === "pnpm") {
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", [bin, ...args].map(quoteWindowsCmdArg).join(" ")],
    };
  }
  return { bin, args };
}

function tailText(value, limit = 1200) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function readOnlyEnv() {
  return {
    ...process.env,
    ...OKX_HEARTBEAT_READ_ONLY_ENV_LOCKS,
  };
}

async function readJsonReport(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return {
      exists: true,
      path: relativePath,
      digest: sha256Text(raw),
      report: JSON.parse(raw.replace(/^\uFEFF/u, "")),
    };
  } catch {
    return {
      exists: false,
      path: relativePath,
      digest: "",
      report: null,
    };
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function runRefreshCommand() {
  const startedAtMs = Date.now();
  const spawn = spawnSpec("pnpm", ["okx:current-readiness:refresh"]);
  const child = spawnSync(spawn.bin, spawn.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: readOnlyEnv(),
    shell: false,
    windowsHide: true,
  });
  const exitCode = typeof child.status === "number" ? child.status : child.error ? 1 : 0;
  return {
    command: REFRESH_COMMAND,
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    durationMs: Date.now() - startedAtMs,
    stdoutTail: tailText(child.stdout),
    stderrTail: tailText(child.stderr || child.error?.message),
  };
}

function assessCurrentReadiness(source) {
  const report = asRecord(source.report);
  const safety = asRecord(report.safety);
  const sourceFreshness = asRecord(report.sourceFreshness);
  const readiness = asRecord(report.readiness);
  const marketSnapshotScheduler = asRecord(readiness.marketSnapshotScheduler);
  const sourceBlockers = stringList(report.blockers);
  const blockers = [];
  if (!source.exists) {
    blockers.push("current_readiness_report_missing");
  }
  if (source.exists && report.status !== "ready_read_only") {
    blockers.push("current_readiness_not_ready");
  }
  if (!isTrue(sourceFreshness.ok)) {
    blockers.push("source_freshness_not_ok");
  }
  if (!isTrue(safety.noOrderWrite)) {
    blockers.push("no_order_write_not_locked");
  }
  for (const blocker of sourceBlockers) {
    blockers.push(`source_${blocker}`);
  }
  return {
    ready: blockers.length === 0,
    refreshRecommended: blockers.length > 0,
    blockers,
    sourceBlockers,
    machineLine: typeof report.machineLine === "string" ? report.machineLine : "",
    status:
      typeof report.status === "string" ? report.status : source.exists ? "unknown" : "missing",
    generatedAt: typeof report.generatedAt === "string" ? report.generatedAt : "",
    schedulerNextRunAt:
      typeof marketSnapshotScheduler.nextRunAt === "string"
        ? marketSnapshotScheduler.nextRunAt
        : "",
    schedulerNextRunWithinGrace: isTrue(marketSnapshotScheduler.nextRunWithinGrace),
    sourceFreshnessOk: isTrue(sourceFreshness.ok),
    sourceNoOrderWrite: isTrue(safety.noOrderWrite),
  };
}

function summarizeInventoryProbe(source) {
  const report = asRecord(source.report);
  const summary = asRecord(report.summary);
  const closure = asRecord(summary.okxCurrentReadinessInventoryProbeClosure);
  const machineLine = typeof closure.machineLine === "string" ? closure.machineLine : "";
  const missingTokens = stringList(closure.missingTokens);
  const publishProbeCount = Number(closure.publishProbeCount);
  const noOrderWrite = isTrue(closure.noOrderWrite) || machineLine.includes("noOrderWrite=true");
  const ready =
    source.exists &&
    closure.status === "ready" &&
    missingTokens.length === 0 &&
    noOrderWrite &&
    machineLine.includes("okxInventoryProbe=pass");
  return {
    ready,
    status:
      typeof closure.status === "string"
        ? closure.status
        : source.exists
          ? "missing"
          : "report_missing",
    machineLine,
    noOrderWrite,
    missingTokens,
    publishProbeCount: Number.isFinite(publishProbeCount) ? publishProbeCount : 0,
  };
}

function summarizePublishBridgeStatus(source) {
  const report = asRecord(source.report);
  const upstreamCounts = asRecord(report.upstreamMessageTokenCounts);
  const upstreamNoOrderWriteCount = Number(report.upstreamNoOrderWriteCount);
  const upstreamExecuteRequiredCount = Number(report.upstreamExecuteRequiredCount);
  const upstreamOkxContractCount = Number(report.upstreamOkxContractCount);
  const upstreamDmadGateCount = Number(report.upstreamDmadGateCount);
  const summaryZhTw =
    typeof report.upstreamMessageTokenCountsSummaryZhTw === "string"
      ? report.upstreamMessageTokenCountsSummaryZhTw
      : "";
  const upstreamNoOrderWriteVerified =
    isTrue(report.upstreamNoOrderWriteVerified) ||
    (upstreamNoOrderWriteCount === 4 && summaryZhTw.includes("noOrderWrite=true=4"));
  const upstreamDmadGateVerified =
    isTrue(report.upstreamDmadGateVerified) ||
    (upstreamDmadGateCount === 1 &&
      upstreamCounts.dmadGate === 1 &&
      summaryZhTw.includes("DMAD=1"));
  const upstreamOkxContractVerified =
    isTrue(report.upstreamOkxContractVerified) ||
    (upstreamOkxContractCount === 1 &&
      upstreamCounts.okxContract === 1 &&
      summaryZhTw.includes("OKX合約=1"));
  const ready =
    source.exists &&
    report.status === "dry_run_ok" &&
    report.upstreamStatus === "dry_run_ok" &&
    upstreamNoOrderWriteVerified &&
    upstreamCounts.noOrderWrite === 4 &&
    upstreamCounts.localExecutorDispatch === 1 &&
    upstreamOkxContractVerified &&
    upstreamCounts.okxContract === 1 &&
    upstreamDmadGateVerified &&
    upstreamCounts.dmadGate === 1;
  const machineLine = [
    `publishBridge=${ready ? "pass" : "fail"}`,
    `upstreamNoOrderWriteVerified=${String(upstreamNoOrderWriteVerified)}`,
    `upstreamNoOrderWriteCount=${Number.isFinite(upstreamNoOrderWriteCount) ? upstreamNoOrderWriteCount : 0}`,
    `upstreamExecuteRequiredCount=${
      Number.isFinite(upstreamExecuteRequiredCount) ? upstreamExecuteRequiredCount : 0
    }`,
    `upstreamOkxContractVerified=${String(upstreamOkxContractVerified)}`,
    `upstreamOkxContractCount=${Number.isFinite(upstreamOkxContractCount) ? upstreamOkxContractCount : 0}`,
    `upstreamDmadGateVerified=${String(upstreamDmadGateVerified)}`,
    `upstreamDmadGateCount=${Number.isFinite(upstreamDmadGateCount) ? upstreamDmadGateCount : 0}`,
    "noOrderWrite=true=4",
    "本地執行器=1",
    "OKX合約=1",
    "DMAD=1",
  ].join(" ");
  return {
    ready,
    status:
      typeof report.status === "string" ? report.status : source.exists ? "unknown" : "missing",
    path: source.path,
    digest: source.digest,
    machineLine,
    upstreamStatus: typeof report.upstreamStatus === "string" ? report.upstreamStatus : "missing",
    upstreamNoOrderWriteVerified,
    upstreamNoOrderWriteCount: Number.isFinite(upstreamNoOrderWriteCount)
      ? upstreamNoOrderWriteCount
      : 0,
    upstreamExecuteRequiredCount: Number.isFinite(upstreamExecuteRequiredCount)
      ? upstreamExecuteRequiredCount
      : 0,
    upstreamOkxContractVerified,
    upstreamOkxContractCount: Number.isFinite(upstreamOkxContractCount)
      ? upstreamOkxContractCount
      : 0,
    upstreamDmadGateVerified,
    upstreamDmadGateCount: Number.isFinite(upstreamDmadGateCount) ? upstreamDmadGateCount : 0,
    upstreamMessageTokenCountsSummaryZhTw: summaryZhTw,
  };
}

export async function buildOkxCurrentReadinessHeartbeatOperation(options = {}) {
  const execute = isTrue(options.execute);
  let currentReadiness =
    options.currentReadiness ?? (await readJsonReport(CURRENT_READINESS_REPORT));
  let refreshWorkflow = options.refreshWorkflow ?? (await readJsonReport(REFRESH_WORKFLOW_REPORT));
  let inventoryProbe =
    options.inventoryProbe ?? (await readJsonReport(TELEGRAM_TRADING_SHORTCUTS_REPORT));
  let publishBridgeStatus =
    options.publishBridgeStatus ?? (await readJsonReport(TELEGRAM_PUBLISH_BRIDGE_STATUS_REPORT));
  const before = assessCurrentReadiness(currentReadiness);
  let refreshRun = null;

  if (execute && before.refreshRecommended && !isTrue(options.skipRun)) {
    refreshRun = runRefreshCommand();
    currentReadiness = await readJsonReport(CURRENT_READINESS_REPORT);
    refreshWorkflow = await readJsonReport(REFRESH_WORKFLOW_REPORT);
    if (options.inventoryProbe === undefined) {
      inventoryProbe = await readJsonReport(TELEGRAM_TRADING_SHORTCUTS_REPORT);
    }
    if (options.publishBridgeStatus === undefined) {
      publishBridgeStatus = await readJsonReport(TELEGRAM_PUBLISH_BRIDGE_STATUS_REPORT);
    }
  } else if (execute && !before.refreshRecommended) {
    refreshRun = {
      command: REFRESH_COMMAND,
      status: "skipped_not_needed",
      exitCode: null,
      durationMs: 0,
      stdoutTail: "",
      stderrTail: "",
    };
  }

  const after = assessCurrentReadiness(currentReadiness);
  const inventoryProbeSummary = summarizeInventoryProbe(inventoryProbe);
  const publishBridgeStatusSummary = summarizePublishBridgeStatus(publishBridgeStatus);
  const inventoryProbeReady = inventoryProbeSummary.ready && publishBridgeStatusSummary.ready;
  const inventoryProbeMachineLine = [
    inventoryProbeSummary.machineLine,
    publishBridgeStatusSummary.machineLine,
  ]
    .filter((item) => item.length > 0)
    .join(" ");
  const refreshFailed = refreshRun?.status === "fail";
  const readyIdle = !execute && !before.refreshRecommended;
  const refreshed = execute && refreshRun?.status === "pass" && after.ready;
  const refreshAvailable = !execute && before.refreshRecommended;
  const status = refreshFailed
    ? "blocked"
    : refreshed
      ? "refreshed_read_only"
      : refreshAvailable
        ? "refresh_available_read_only"
        : readyIdle
          ? "ready_idle_read_only"
          : after.ready
            ? "ready_idle_read_only"
            : "refresh_available_read_only";
  const code =
    status === "blocked"
      ? "okx_current_readiness_heartbeat_blocked"
      : status === "refreshed_read_only"
        ? "okx_current_readiness_heartbeat_refreshed"
        : status === "ready_idle_read_only"
          ? "okx_current_readiness_heartbeat_ready_idle"
          : "okx_current_readiness_heartbeat_refresh_available";
  const blockers = refreshFailed ? ["refresh_command_failed", ...after.blockers] : after.blockers;
  const machineStatus =
    status === "refreshed_read_only"
      ? "refreshed"
      : status === "ready_idle_read_only"
        ? "idle"
        : status === "blocked"
          ? "blocked"
          : "refresh_available";
  const machineLine = [
    `okxCurrentReadinessHeartbeat=${machineStatus}`,
    `current=${after.ready ? "ready" : "blocked"}`,
    `refresh=${before.refreshRecommended ? "available" : "not_needed"}`,
    `schedulerNextRunAt=${after.schedulerNextRunAt || "unavailable"}`,
    "telegram=sc:tr:okxrefresh",
    "command=okx:current-readiness:refresh",
    `inventoryProbe=${inventoryProbeReady ? "ready" : "blocked"}`,
    "noOrderWrite=true",
  ].join(" ");

  return {
    schema: "openclaw.okx.current-readiness-heartbeat-operation.v1",
    generatedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    provider: "okx",
    language: "zh-TW",
    mode: execute ? "heartbeat_execute_read_only_refresh" : "heartbeat_plan_read_only_refresh",
    status,
    code,
    summary_zh_tw:
      status === "refreshed_read_only"
        ? "OKX heartbeat 已執行 safe refresh workflow，current-readiness 已回到 ready，noOrderWrite=true。"
        : status === "ready_idle_read_only"
          ? "OKX heartbeat 檢查完成：current-readiness 仍為 ready，暫不需要刷新。"
          : status === "blocked"
            ? `OKX heartbeat refresh 執行失敗：${blockers.join("、")}。`
            : "OKX heartbeat 檢查完成：偵測到 stale/blocker，可用 sc:tr:okxrefresh 或 pnpm okx:current-readiness:heartbeat:execute 一鍵刷新。",
    blockers,
    markers: [
      status === "refreshed_read_only"
        ? "heartbeat_refresh_executed"
        : status === "ready_idle_read_only"
          ? "heartbeat_ready_idle"
          : status === "blocked"
            ? "heartbeat_refresh_blocked"
            : "heartbeat_refresh_available",
      "telegram_okxrefresh_available",
      "read_only_heartbeat_operation",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
      inventoryProbeReady ? "inventory_probe_ready" : "inventory_probe_blocked",
      publishBridgeStatusSummary.ready
        ? "publish_bridge_status_ready"
        : "publish_bridge_status_blocked",
      publishBridgeStatusSummary.upstreamDmadGateVerified
        ? "publish_bridge_dmad_gate_ready"
        : "publish_bridge_dmad_gate_blocked",
      publishBridgeStatusSummary.upstreamOkxContractVerified
        ? "publish_bridge_okx_contract_ready"
        : "publish_bridge_okx_contract_blocked",
      "no_order_write_true",
    ],
    machineLine,
    action: {
      telegramCallback: "sc:tr:okxrefresh",
      heartbeatCommand: "pnpm okx:current-readiness:heartbeat",
      executeCommand: "pnpm okx:current-readiness:heartbeat:execute",
      refreshCommand: REFRESH_COMMAND,
      refreshCheckCommand: "pnpm okx:current-readiness:refresh:check",
      readinessCheckCommand: "pnpm okx:current-readiness:check",
      oneClickRefresh: true,
      executeRequired: before.refreshRecommended,
    },
    reports: {
      heartbeat: repoRelative(DEFAULT_REPORT_PATH),
      currentReadiness: {
        path: currentReadiness.path,
        exists: currentReadiness.exists,
        digest: currentReadiness.digest,
        status: after.status,
        generatedAt: after.generatedAt,
        schedulerNextRunAt: after.schedulerNextRunAt,
        schedulerNextRunWithinGrace: after.schedulerNextRunWithinGrace,
        machineLine: after.machineLine,
      },
      refreshWorkflow: {
        path: refreshWorkflow.path,
        exists: refreshWorkflow.exists,
        digest: refreshWorkflow.digest,
        status: asRecord(refreshWorkflow.report).status ?? "missing",
        machineLine: asRecord(refreshWorkflow.report).machineLine ?? "",
      },
      inventoryProbe: {
        path: inventoryProbe.path,
        exists: inventoryProbe.exists,
        digest: inventoryProbe.digest,
        status: inventoryProbeSummary.status,
        ready: inventoryProbeReady,
        telegramShortcutReady: inventoryProbeSummary.ready,
        machineLine: inventoryProbeMachineLine,
        publishProbeCount: inventoryProbeSummary.publishProbeCount,
        missingTokens: inventoryProbeSummary.missingTokens,
        noOrderWrite: inventoryProbeSummary.noOrderWrite,
        publishBridgeStatus: publishBridgeStatusSummary,
      },
    },
    refreshRun,
    safety: {
      readOnly: true,
      paperOnly: true,
      summaryOnly: true,
      heartbeatOnly: !execute,
      refreshOnly: true,
      privateOrderQueryEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      withdrawalEnabled: false,
      noOrderWrite: true,
      sourceNoOrderWrite: after.sourceNoOrderWrite,
    },
    commands: {
      available: [
        "pnpm okx:current-readiness:heartbeat",
        "pnpm okx:current-readiness:heartbeat:execute",
        REFRESH_COMMAND,
        "pnpm okx:current-readiness:refresh:check",
        "pnpm okx:current-readiness:check",
      ],
      executed: refreshRun?.status === "pass" ? [REFRESH_COMMAND] : [],
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
        "POST /api/v5/asset/withdrawal",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "GET /api/v5/trade/order",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
        "POST /api/v5/asset/withdrawal",
      ],
    },
    nextSafeTask: OKX_HEARTBEAT_NEXT_SAFE_TASK,
  };
}

async function main() {
  const reportPath = path.resolve(argValue("--out", DEFAULT_REPORT_PATH));
  const report = await buildOkxCurrentReadinessHeartbeatOperation({
    execute: hasFlag("--execute"),
  });
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(reportPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OKX_CURRENT_READINESS_HEARTBEAT_OPERATION",
      `status=${report.status}`,
      `code=${report.code}`,
      `machineLine=${report.machineLine}`,
      `blockers=${report.blockers.join("/")}`,
      `report=${repoRelative(reportPath)}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] === currentFile) {
  await main();
}
