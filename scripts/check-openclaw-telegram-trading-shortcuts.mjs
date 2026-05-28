#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-telegram-trading-shortcuts-latest.json",
);
const summaryPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-telegram-trading-shortcuts-summary.md",
);

const files = {
  tradingCopy: path.join(
    repoRoot,
    "extensions",
    "automation",
    "src",
    "telegram-ui",
    "trading-copy.ts",
  ),
  tradingPanel: path.join(
    repoRoot,
    "extensions",
    "automation",
    "src",
    "telegram-ui",
    "trading-panel.ts",
  ),
  callbackRouter: path.join(
    repoRoot,
    "extensions",
    "automation",
    "src",
    "telegram-ui",
    "callback-router.ts",
  ),
  callbackRouterTest: path.join(
    repoRoot,
    "extensions",
    "automation",
    "src",
    "telegram-ui",
    "callback-router.test.ts",
  ),
  tradingPanelTest: path.join(
    repoRoot,
    "extensions",
    "automation",
    "src",
    "telegram-ui",
    "trading-panel.test.ts",
  ),
  tradingGateway: path.join(repoRoot, "src", "gateway", "server-methods", "trading.ts"),
  packageJson: path.join(repoRoot, "package.json"),
  assistantState: path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json"),
  okxCurrentReadinessSummaryReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-okx-current-readiness-summary-latest.json",
  ),
  okxCurrentReadinessHeartbeatOperationReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-okx-current-readiness-heartbeat-operation-latest.json",
  ),
  okxCurrentReadinessRefreshWorkflowReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-okx-current-readiness-refresh-workflow-latest.json",
  ),
  controlledRunnerTelegramPublishReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-controlled-task-runner-telegram-publish-latest.json",
  ),
  capitalOperatorPacketReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-live-operator-execution-packet-latest.json",
  ),
  capitalLocalExecutorDispatchReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  ),
  capitalLiveExecutorArmProfileReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-live-executor-arm-profile-latest.json",
  ),
  capitalStrategyPlatformReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-direct-strategy-platform-gate-latest.json",
  ),
  capitalTailRiskRepairReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-strategy-tail-risk-repair-latest.json",
  ),
  capitalRiskResizedPaperRerunReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
  ),
  capitalHighConfidencePaperRerunReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
  ),
  capitalTradeAutoCycleReport: path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-trade-auto-cycle-latest.json",
  ),
  controlledRunnerScript: path.join(repoRoot, "scripts", "openclaw-controlled-task-runner.mjs"),
  autonomousInventoryScript: path.join(repoRoot, "scripts", "openclaw-autonomous-inventory.mjs"),
  checkerScript: path.join(repoRoot, "scripts", "check-openclaw-telegram-trading-shortcuts.mjs"),
};

const shortcuts = [
  {
    id: "ai-platform",
    copyKey: "aiPlatform",
    label: "AI 交易平台",
    callback: "sc:tr:platform",
    callbackCase: 'case "platform"',
    commands: [],
    gatewayMethods: ["trading.snapshot"],
  },
  {
    id: "okx-status",
    copyKey: "okxStatus",
    label: "OKX 狀態",
    callback: "sc:tr:okx",
    callbackCase: 'case "okx"',
    commands: [],
  },
  {
    id: "capital-core-product-quotes",
    copyKey: "coreProductQuotes",
    label: "全商品報價",
    callback: "sc:tr:corequote",
    callbackCase: 'case "corequote"',
    commands: [
      "pnpm capital:quote:core-products:check",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:quote:core-products:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "okx-current-readiness-refresh",
    copyKey: "okxReadinessRefresh",
    label: "OKX 刷新",
    callback: "sc:tr:okxrefresh",
    callbackCase: 'case "okxrefresh"',
    commands: ["pnpm okx:current-readiness:refresh", "pnpm okx:current-readiness:refresh:check"],
    packageScripts: ["okx:current-readiness:refresh", "okx:current-readiness:refresh:check"],
  },
  {
    id: "okx-order-proposal",
    copyKey: "okxOrderProposal",
    label: "OKX 提案",
    callback: "sc:tr:okxord",
    callbackCase: 'case "okxord"',
    commands: [],
  },
  {
    id: "okx-order-status",
    copyKey: "okxOrderStatus",
    label: "OKX 訂單",
    callback: "sc:tr:okxstat",
    callbackCase: 'case "okxstat"',
    commands: [],
  },
  {
    id: "hft",
    copyKey: "hftGates",
    label: "高頻閘門",
    callback: "sc:tr:hft",
    callbackCase: 'case "hft"',
    commands: [
      "node scripts/check-capital-se-hft-hftengine-gate.mjs",
      "node scripts/check-capital-se-hft-riskguard-gate.mjs",
      "node scripts/check-capital-se-hft-hft-config-gate.mjs",
      "node scripts/check-capital-se-hft-strategies-marketmakingstrategy-gate.mjs",
      "node scripts/check-capital-se-hft-strategies-meanreversionhftstrategy-gate.mjs",
      "node scripts/check-capital-se-hft-strategies-orderimbalancestrategy-gate.mjs",
      "node scripts/check-capital-se-hft-strategies-tickmomentumstrategy-gate.mjs",
      "node scripts/check-capital-se-hft-strategies-twapvwapexecutor-gate.mjs",
    ],
  },
  {
    id: "dispatcher",
    copyKey: "dispatcherCheck",
    label: "下單串接",
    callback: "sc:tr:disp",
    callbackCase: 'case "disp"',
    commands: ["pnpm capital-hft:hft-broker-dispatcher:check"],
    packageScripts: ["capital-hft:hft-broker-dispatcher:check"],
  },
  {
    id: "live-blockers",
    copyKey: "liveBlockers",
    label: "實單阻擋",
    callback: "sc:tr:live",
    callbackCase: 'case "live"',
    commands: [
      "pnpm capital-hft:live-trading:approval:summary:check",
      "pnpm capital-hft:live-trading:promotion:check",
    ],
    packageScripts: [
      "capital-hft:live-trading:approval:summary:check",
      "capital-hft:live-trading:promotion:check",
    ],
  },
  {
    id: "direct-operation",
    copyKey: "directOperate",
    label: "直接操作",
    callback: "sc:tr:direct",
    callbackCase: 'case "direct"',
    commands: [],
    packageScripts: [],
  },
  {
    id: "local-executor-dispatch",
    copyKey: "localExecutor",
    label: "本地執行器",
    callback: "sc:tr:localexec",
    callbackCase: 'case "localexec"',
    commands: ["pnpm capital:trade:direct:check"],
    packageScripts: ["capital:trade:direct:check"],
  },
  {
    id: "live-executor-arm-profile",
    copyKey: "liveExecutorArmProfile",
    label: "實單 Arm",
    callback: "sc:tr:armprofile",
    callbackCase: 'case "armprofile"',
    commands: [],
    packageScripts: [
      "capital:trade:live-executor-profile:check",
      "capital:live-readiness:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "trade-auto-cycle",
    copyKey: "tradeAutoCycle",
    label: "交易總循環",
    callback: "sc:tr:auto",
    callbackCase: 'case "auto"',
    commands: [
      "pnpm capital:trade:auto-cycle",
      "pnpm capital:trade:auto-cycle:check",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:trade:auto-cycle",
      "capital:trade:auto-cycle:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "direct-operation-run",
    copyKey: "directRun",
    label: "重跑直接Gate",
    callback: "sc:tr:directrun",
    callbackCase: 'case "directrun"',
    commands: [
      "pnpm capital:trade:direct",
      "pnpm capital:trade:direct:check",
      "pnpm capital:trade:direct:inputs",
      "pnpm capital:trade:direct:inputs:check",
      "pnpm capital:trade:direct:status",
      "pnpm capital:trade:direct:status:check",
      "pnpm capital:trade:operator-packet",
      "pnpm capital:trade:operator-packet:check",
      "pnpm capital-hft:hft-broker-dispatcher:check",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:trade:direct",
      "capital:trade:direct:check",
      "capital:trade:direct:inputs",
      "capital:trade:direct:inputs:check",
      "capital:trade:direct:status",
      "capital:trade:direct:status:check",
      "capital:trade:operator-packet",
      "capital:trade:operator-packet:check",
      "capital-hft:hft-broker-dispatcher:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "direct-operation-position-refresh",
    copyKey: "directPositionRefresh",
    label: "重讀倉位Gate",
    callback: "sc:tr:directpos",
    callbackCase: 'case "directpos"',
    commands: [
      "pnpm capital:trade:direct:status:check",
      "pnpm capital:trade:platform:check",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:trade:direct:status:check",
      "capital:trade:platform:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "adapter-ack-apply-receipt",
    copyKey: "adapterApplyReceipt",
    label: "Ack套用收據",
    callback: "sc:tr:ackapply",
    callbackCase: 'case "ackapply"',
    commands: [
      "pnpm capital:trade:adapter-ack-apply-verifier:check",
      "pnpm capital:trade:adapter-ack-apply-plan:check",
      "pnpm capital:trade:adapter-ack-apply-receipt:check",
      "pnpm capital:trade:adapter-ack:check",
      "pnpm capital:trade:post-apply-closure:check",
      "pnpm capital:trade:direct:check",
      "pnpm capital:trade:direct:status:check",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:trade:adapter-ack-apply-verifier:check",
      "capital:trade:adapter-ack-apply-plan:check",
      "capital:trade:adapter-ack-apply-receipt:check",
      "capital:trade:adapter-ack:check",
      "capital:trade:post-apply-closure:check",
      "capital:trade:direct:check",
      "capital:trade:direct:status:check",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "auto-deactivate-receipt",
    copyKey: "receiptGate",
    label: "回關收據",
    callback: "sc:tr:receipt",
    callbackCase: 'case "receipt"',
    commands: [
      "pnpm capital:live-trading:operator:auto-deactivate:receipt:check",
      "pnpm check:openclaw-controlled-task-runner-telegram-publish",
      "pnpm capital-hft:telegram-trading-shortcuts:check",
    ],
    packageScripts: [
      "capital:live-trading:operator:auto-deactivate:receipt:check",
      "check:openclaw-controlled-task-runner-telegram-publish",
      "capital-hft:telegram-trading-shortcuts:check",
    ],
  },
  {
    id: "paper-assistant",
    copyKey: "paperAssistant",
    label: "模擬助手",
    callback: "sc:tr:assist",
    callbackCase: 'case "assist"',
    commands: [
      "pnpm capital-hft:auto-trading-assistant:check",
      "pnpm capital-hft:auto-trading-loop:check",
      "pnpm capital-hft:auto-trading:check",
    ],
    packageScripts: [
      "capital-hft:auto-trading-assistant:check",
      "capital-hft:auto-trading-loop:check",
      "capital-hft:auto-trading:check",
    ],
    stateEntrypoints: [
      "pnpm capital-hft:auto-trading",
      "pnpm capital-hft:auto-trading-loop",
      "pnpm capital-hft:auto-trading-watch",
    ],
  },
];

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJsonOptional(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function commandFileExists(command) {
  const match = command.match(/^node scripts\/(.+\.mjs)$/u);
  if (!match) {
    return true;
  }
  const requested = match[1];
  const directPath = path.join(repoRoot, "scripts", requested);
  if (fs.existsSync(directPath)) {
    return true;
  }
  // Backward-compatible alias mapping for renamed HFT gate scripts.
  const legacyToCurrent = new Map([
    ["check-capital-se-hft-hftengine-gate.mjs", "openclaw-capital-se-hft-hftengine-gate.mjs"],
    ["check-capital-se-hft-riskguard-gate.mjs", "openclaw-capital-se-hft-riskguard-gate.mjs"],
    ["check-capital-se-hft-hft-config-gate.mjs", "openclaw-capital-se-hft-hft-config-gate.mjs"],
    [
      "check-capital-se-hft-strategies-marketmakingstrategy-gate.mjs",
      "openclaw-capital-se-hft-strategies-marketmakingstrategy-gate.mjs",
    ],
    [
      "check-capital-se-hft-strategies-meanreversionhftstrategy-gate.mjs",
      "openclaw-capital-se-hft-strategies-meanreversionhftstrategy-gate.mjs",
    ],
    [
      "check-capital-se-hft-strategies-orderimbalancestrategy-gate.mjs",
      "openclaw-capital-se-hft-strategies-orderimbalancestrategy-gate.mjs",
    ],
    [
      "check-capital-se-hft-strategies-tickmomentumstrategy-gate.mjs",
      "openclaw-capital-se-hft-strategies-tickmomentumstrategy-gate.mjs",
    ],
    [
      "check-capital-se-hft-strategies-twapvwapexecutor-gate.mjs",
      "openclaw-capital-se-hft-strategies-twapvwapexecutor-gate.mjs",
    ],
  ]);
  const mapped = legacyToCurrent.get(requested);
  if (!mapped) {
    return false;
  }
  return fs.existsSync(path.join(repoRoot, "scripts", mapped));
}

function addCheck(checks, id, passed, details = {}) {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    ...details,
  });
}

function renderList(items) {
  if (!items.length) {
    return "- none";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderFlag(value) {
  return value ? "pass" : "fail";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numericCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function schedulerNextRunAtFromReport(report) {
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const candidates = [
    report?.schedulerNextRunAt,
    report?.readiness?.marketSnapshotScheduler?.nextRunAt,
    report?.reports?.currentReadiness?.schedulerNextRunAt,
    machineLine.match(/\bschedulerNextRunAt=([^\s]+)/u)?.[1],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return "";
}

function noOrderWriteFromReport(report) {
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  return report?.safety?.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
}

function okxSchedulerNoOrderReportStatus(report) {
  const reportRead = report && typeof report === "object";
  const schedulerNextRunAt = schedulerNextRunAtFromReport(report);
  const noOrderWrite = noOrderWriteFromReport(report);
  return {
    reportRead: Boolean(reportRead),
    schedulerNextRunAt,
    schedulerVisible: schedulerNextRunAt.length > 0,
    noOrderWrite,
    ready: Boolean(reportRead) && schedulerNextRunAt.length > 0 && noOrderWrite,
  };
}

function buildFixtureCoverageSummary(checks) {
  const fixtureCoverageCheck =
    checks.find(
      (check) =>
        check.id === "fast-ticket-audit:callback-learning-summary-shared-formatter-fixture",
    ) ?? {};
  const targets = Array.isArray(fixtureCoverageCheck.targets)
    ? fixtureCoverageCheck.targets
    : fixtureCoverageCheck.target
      ? [fixtureCoverageCheck.target]
      : [];
  return {
    status: fixtureCoverageCheck.status ?? "missing",
    checkId:
      fixtureCoverageCheck.id ??
      "fast-ticket-audit:callback-learning-summary-shared-formatter-fixture",
    targets,
  };
}

function hasPassedCheck(checks, id) {
  return checks.some((check) => check.id === id && check.status === "pass");
}

function buildOkxPaperAuditClosure(checks) {
  const platformSnapshotRead = hasPassedCheck(
    checks,
    "ai-platform:okx-paper-audit-summary-snapshot",
  );
  const platformVisible = hasPassedCheck(checks, "ai-platform:okx-paper-audit-summary-visible");
  const okxStatusRead = hasPassedCheck(checks, "okx-order-status:paper-audit-summary-read");
  const okxStatusVisible = hasPassedCheck(checks, "okx-order-status:paper-audit-summary-visible");
  const noOrderWrite = platformSnapshotRead && platformVisible && okxStatusRead && okxStatusVisible;
  const status = noOrderWrite ? "pass" : "fail";
  const reportPath = "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json";
  const machineLine = [
    `okxPaperAudit=${status}`,
    `platform=${platformSnapshotRead && platformVisible ? "read+visible" : "missing"}`,
    `okxstat=${okxStatusRead && okxStatusVisible ? "read+visible" : "missing"}`,
    `report=${reportPath}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    callbackPair: ["sc:tr:platform", "sc:tr:okxstat"],
    platformSnapshotRead,
    platformVisible,
    okxStatusRead,
    okxStatusVisible,
    noOrderWrite,
    reportPath,
    machineLine,
  };
}

function buildOkxCurrentReadinessClosure(checks) {
  const okxStatusRead = hasPassedCheck(checks, "okx-current-readiness:okx-status-read");
  const okxStatusVisible = hasPassedCheck(checks, "okx-current-readiness:okx-status-visible");
  const assistantSummaryRead = hasPassedCheck(
    checks,
    "okx-current-readiness:assistant-summary-read",
  );
  const assistantStatusStripVisible = hasPassedCheck(
    checks,
    "okx-current-readiness:assistant-status-strip-visible",
  );
  const refreshEntryVisible = hasPassedCheck(checks, "okx-current-readiness:refresh-entry-visible");
  const refreshRouterReady = hasPassedCheck(checks, "okx-current-readiness:refresh-router-ready");
  const schedulerRead = hasPassedCheck(checks, "okx-market-snapshot-scheduler:okx-status-read");
  const schedulerVisible = hasPassedCheck(
    checks,
    "okx-market-snapshot-scheduler:okx-status-visible",
  );
  const readinessSchedulerEvidence = hasPassedCheck(
    checks,
    "okx-current-readiness:scheduler-evidence-visible",
  );
  const noOrderWrite =
    okxStatusRead &&
    okxStatusVisible &&
    schedulerRead &&
    schedulerVisible &&
    readinessSchedulerEvidence &&
    assistantSummaryRead &&
    assistantStatusStripVisible &&
    refreshEntryVisible &&
    refreshRouterReady;
  const status = noOrderWrite ? "ready" : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json";
  const machineLine = [
    `okxCurrentReadiness=${status}`,
    `okx=${okxStatusRead && okxStatusVisible ? "read+visible" : "missing"}`,
    `scheduler=${
      schedulerRead && schedulerVisible && readinessSchedulerEvidence ? "read+visible" : "missing"
    }`,
    `assist=${assistantSummaryRead && assistantStatusStripVisible ? "read+visible" : "missing"}`,
    `refresh=${refreshEntryVisible && refreshRouterReady ? "available" : "missing"}`,
    `report=${reportPath}`,
    `freshness=${noOrderWrite ? "ok" : "stale"}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    callbackPair: ["sc:tr:okx", "sc:tr:okxrefresh", "sc:tr:assist"],
    okxStatusRead,
    okxStatusVisible,
    assistantSummaryRead,
    assistantStatusStripVisible,
    schedulerRead,
    schedulerVisible,
    readinessSchedulerEvidence,
    refreshEntryVisible,
    refreshRouterReady,
    noOrderWrite,
    reportPath,
    machineLine,
  };
}

function buildOkxCurrentReadinessRefreshWorkflowClosure(checks, report, heartbeatReport) {
  const reportRead = report && typeof report === "object";
  const assistantStatusStripVisible = hasPassedCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:assistant-status-strip-visible",
  );
  const safety = report && typeof report.safety === "object" ? report.safety : {};
  const steps = Array.isArray(report?.steps) ? report.steps.filter((step) => step) : [];
  const totalSteps = steps.length;
  const passedSteps = steps.filter((step) => step?.status === "pass").length;
  const failedSteps = steps
    .filter((step) => step?.status !== "pass")
    .map((step) => String(step?.id ?? "unknown"));
  const recoverableFailedSteps = new Set(["telegram_shortcuts", "current_readiness_summary"]);
  const hasOnlyRecoverableFailures =
    failedSteps.length > 0 && failedSteps.every((stepId) => recoverableFailedSteps.has(stepId));
  const refreshRun =
    heartbeatReport?.refreshRun && typeof heartbeatReport.refreshRun === "object"
      ? heartbeatReport.refreshRun
      : null;
  const sourceMachineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const sourceNoOrderWrite = safety?.noOrderWrite !== false;
  const noOrderWrite =
    Boolean(reportRead) &&
    assistantStatusStripVisible &&
    sourceNoOrderWrite &&
    (sourceMachineLine.length === 0 || sourceMachineLine.includes("noOrderWrite=true"));
  const status =
    noOrderWrite && (failedSteps.length === 0 || hasOnlyRecoverableFailures) ? "ready" : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json";
  const machineLine =
    sourceMachineLine ||
    [
      `okxCurrentReadinessRefresh=${status === "ready" ? "pass" : "fail"}`,
      `steps=${passedSteps}/${totalSteps}`,
      `report=${reportPath}`,
      `noOrderWrite=${noOrderWrite}`,
    ].join(" ");
  return {
    status,
    code: typeof report?.code === "string" ? report.code : "",
    callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
    reportRead: Boolean(reportRead),
    assistantStatusStripVisible,
    totalSteps,
    passedSteps,
    failedSteps,
    latestRefreshRunStatus: refreshRun?.status ?? "skipped_not_needed",
    latestRefreshRunExitCode: refreshRun?.exitCode ?? "null",
    noOrderWrite,
    reportPath,
    machineLine,
  };
}

function buildOkxCurrentReadinessHeartbeatOperationClosure(checks, report) {
  const reportRead = hasPassedCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:report-read",
  );
  const assistantStatusStripVisible = hasPassedCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:assistant-status-strip-visible",
  );
  const commandsVisible = hasPassedCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:commands-visible",
  );
  const action = report && typeof report.action === "object" ? report.action : {};
  const safety = report && typeof report.safety === "object" ? report.safety : {};
  const reports = report && typeof report.reports === "object" ? report.reports : {};
  const inventoryProbe =
    reports && typeof reports.inventoryProbe === "object" ? reports.inventoryProbe : {};
  const inventoryProbeMachineLine =
    typeof inventoryProbe?.machineLine === "string" ? inventoryProbe.machineLine : "";
  const publishBridgeStatus = asObject(inventoryProbe?.publishBridgeStatus);
  const publishBridgeMachineLine =
    typeof publishBridgeStatus.machineLine === "string" ? publishBridgeStatus.machineLine : "";
  const publishBridgeStatusReady =
    publishBridgeStatus.ready === true || publishBridgeMachineLine.includes("publishBridge=pass");
  const upstreamNoOrderWriteVerified =
    publishBridgeStatus.upstreamNoOrderWriteVerified === true ||
    publishBridgeMachineLine.includes("upstreamNoOrderWriteVerified=true");
  const upstreamDmadGateVerified =
    publishBridgeStatus.upstreamDmadGateVerified === true ||
    publishBridgeMachineLine.includes("upstreamDmadGateVerified=true");
  const upstreamOkxContractVerified =
    publishBridgeStatus.upstreamOkxContractVerified === true ||
    publishBridgeMachineLine.includes("upstreamOkxContractVerified=true");
  const upstreamNoOrderWriteCount = numericCount(publishBridgeStatus.upstreamNoOrderWriteCount);
  const upstreamExecuteRequiredCount = numericCount(
    publishBridgeStatus.upstreamExecuteRequiredCount,
  );
  const upstreamOkxContractCount = numericCount(publishBridgeStatus.upstreamOkxContractCount);
  const upstreamDmadGateCount = numericCount(publishBridgeStatus.upstreamDmadGateCount);
  const inventoryProbeReady =
    inventoryProbe?.ready === true || inventoryProbeMachineLine.includes("okxInventoryProbe=pass");
  const inventoryProbeNoOrderWrite =
    inventoryProbe?.noOrderWrite === true ||
    inventoryProbeMachineLine.includes("noOrderWrite=true");
  const sourceMachineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const currentReadiness =
    reports && typeof reports.currentReadiness === "object" ? reports.currentReadiness : {};
  const schedulerNextRunAtFromReport =
    typeof currentReadiness?.schedulerNextRunAt === "string"
      ? currentReadiness.schedulerNextRunAt
      : "";
  const schedulerNextRunAtFromMachineLine =
    sourceMachineLine.match(/\bschedulerNextRunAt=([^\s]+)/u)?.[1] ?? "";
  const schedulerNextRunAt = schedulerNextRunAtFromReport || schedulerNextRunAtFromMachineLine;
  const nextSafeTask = typeof report?.nextSafeTask === "string" ? report.nextSafeTask : "";
  const sourceNoOrderWrite = safety?.noOrderWrite !== false;
  const noOrderWrite =
    reportRead &&
    assistantStatusStripVisible &&
    commandsVisible &&
    sourceNoOrderWrite &&
    (sourceMachineLine.length === 0 || sourceMachineLine.includes("noOrderWrite=true"));
  const status = noOrderWrite ? "ready" : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json";
  const machineLine =
    sourceMachineLine ||
    [
      `okxCurrentReadinessHeartbeat=visible`,
      `current=summary`,
      `refresh=available`,
      `telegram=sc:tr:okxrefresh`,
      `command=okx:current-readiness:refresh`,
      `report=${reportPath}`,
      `noOrderWrite=${noOrderWrite}`,
    ].join(" ");
  return {
    status,
    callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
    reportRead,
    assistantStatusStripVisible,
    commandsVisible,
    telegramCallback:
      typeof action?.telegramCallback === "string" ? action.telegramCallback : "sc:tr:okxrefresh",
    heartbeatCommand:
      typeof action?.heartbeatCommand === "string"
        ? action.heartbeatCommand
        : "pnpm okx:current-readiness:heartbeat",
    executeCommand:
      typeof action?.executeCommand === "string"
        ? action.executeCommand
        : "pnpm okx:current-readiness:heartbeat:execute",
    refreshCommand:
      typeof action?.refreshCommand === "string"
        ? action.refreshCommand
        : "pnpm okx:current-readiness:refresh",
    oneClickRefresh:
      typeof action?.oneClickRefresh === "boolean" ? action.oneClickRefresh : noOrderWrite,
    executeRequired: typeof action?.executeRequired === "boolean" ? action.executeRequired : false,
    inventoryProbeStatus:
      typeof inventoryProbe?.status === "string"
        ? inventoryProbe.status
        : inventoryProbeReady
          ? "ready"
          : "unknown",
    inventoryProbeReady,
    inventoryProbeNoOrderWrite,
    inventoryProbeMachineLine,
    publishBridgeStatusReady,
    publishBridgeMachineLine,
    upstreamNoOrderWriteVerified,
    upstreamOkxContractVerified,
    upstreamDmadGateVerified,
    upstreamNoOrderWriteCount,
    upstreamExecuteRequiredCount,
    upstreamOkxContractCount,
    upstreamDmadGateCount,
    upstreamMessageTokenCountsSummaryZhTw:
      typeof publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw === "string"
        ? publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw
        : "",
    schedulerNextRunAt,
    noOrderWrite,
    nextSafeTask,
    reportPath,
    machineLine,
  };
}

function buildOkxCurrentReadinessInventoryProbeClosure(inventoryScript) {
  const publishProbeTokens = [
    "contract-probe:controlled-telegram-publish-message-position-snapshot",
    "contract-probe:controlled-telegram-publish-message-okx-refresh",
    "contract-probe:controlled-telegram-publish-message-okx-heartbeat-refresh",
    "contract-probe:controlled-telegram-publish-message-okx-heartbeat-execute-required",
    "contract-probe:controlled-telegram-publish-message-okx-heartbeat-scheduler-next-run-at",
    "contract-probe:controlled-telegram-publish-message-no-order-write",
    "contract-probe:controlled-telegram-publish-token-summary-okx-refresh",
    "contract-probe:controlled-telegram-publish-token-summary-okx-heartbeat",
    "contract-probe:controlled-telegram-publish-token-summary-okx-contract",
    "contract-probe:controlled-telegram-publish-token-summary-position-snapshot",
    "contract-probe:controlled-telegram-publish-token-summary-no-order-write",
    "contract-probe:controlled-telegram-publish-token-summary-dmad-gate",
    "contract-probe:controlled-telegram-publish-token-count-okx-contract",
    "contract-probe:controlled-telegram-publish-token-count-position-snapshot",
    "contract-probe:controlled-telegram-publish-token-count-no-order-write",
    "contract-probe:controlled-telegram-publish-token-count-dmad-gate",
    "contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt",
    "contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt-verified",
  ];
  const requiredTokens = [
    "summary.okxCurrentReadinessRefreshWorkflowClosure.machineLine",
    "summary.okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite",
    "okx_current_readiness_refresh_workflow.machineLine",
    "okx_current_readiness_refresh_workflow.noOrderWrite",
    "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
    "okxHeartbeatRefresh=",
    "schedulerNextRunAt=",
    "executeRequired=",
    "OKX心跳=okxHeartbeatRefresh=",
    "OKX刷新=okxCurrentReadinessRefresh=",
    "noOrderWrite=true",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-refresh",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-execute-required",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-scheduler-next-run-at",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-no-order-write",
    "contract-probe:telegram-summary-okx-scheduler-no-order-contract",
    ...publishProbeTokens,
  ];
  const missingTokens = requiredTokens.filter((token) => !inventoryScript.includes(token));
  const summaryProbeTokens = [
    "contract-probe:controlled-telegram-summary-okx-heartbeat-refresh",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-execute-required",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-scheduler-next-run-at",
    "contract-probe:controlled-telegram-summary-okx-heartbeat-no-order-write",
    "contract-probe:telegram-summary-okx-scheduler-no-order-contract",
  ];
  const summaryProbeCount = summaryProbeTokens.filter((token) =>
    inventoryScript.includes(token),
  ).length;
  const publishProbeCount = publishProbeTokens.filter((token) =>
    inventoryScript.includes(token),
  ).length;
  const noOrderWrite =
    inventoryScript.includes("summary.okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite") &&
    inventoryScript.includes("summary.okxSchedulerNoOrderContractProbeClosure.noOrderWrite") &&
    inventoryScript.includes("okx_current_readiness_refresh_workflow.noOrderWrite") &&
    inventoryScript.includes("telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine") &&
    inventoryScript.includes("noOrderWrite=true");
  const status = missingTokens.length === 0 && noOrderWrite ? "ready" : "blocked";
  const machineLine = [
    `okxInventoryProbe=${status === "ready" ? "pass" : "fail"}`,
    `summaryProbes=${summaryProbeCount}/${summaryProbeTokens.length}`,
    `publishProbes=${publishProbeCount}/${publishProbeTokens.length}`,
    `summary=telegram+controlled`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    requiredTokens,
    missingTokens,
    summaryProbeCount,
    summaryProbeExpectedCount: summaryProbeTokens.length,
    publishProbeCount,
    publishProbeExpectedCount: publishProbeTokens.length,
    noOrderWrite,
    machineLine,
  };
}

function buildOkxHeartbeatPublishTokenCountClosure(report) {
  const reportRead = report && typeof report === "object";
  const counts = asObject(report?.messageTokenCounts);
  const summaryZhTw =
    typeof report?.messageTokenCountsSummaryZhTw === "string"
      ? report.messageTokenCountsSummaryZhTw
      : "";
  const okxRefresh = numericCount(counts.okxRefresh);
  const okxHeartbeat = numericCount(counts.okxHeartbeat);
  const okxContract = numericCount(counts.okxContract);
  const localExecutorDispatch = numericCount(counts.localExecutorDispatch);
  const positionSnapshot = numericCount(counts.positionSnapshot);
  const executeRequired = numericCount(counts.executeRequired);
  const noOrderWriteCount = numericCount(counts.noOrderWrite);
  const noOrderWrite = noOrderWriteCount === 4 && summaryZhTw.includes("noOrderWrite=true=4");
  const status =
    reportRead &&
    okxRefresh === 1 &&
    okxHeartbeat === 1 &&
    okxContract === 1 &&
    localExecutorDispatch === 1 &&
    positionSnapshot === 1 &&
    executeRequired === 1 &&
    noOrderWrite
      ? "ready"
      : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json";
  const machineLine = [
    `okxHeartbeatPublishTokenCounts=${status === "ready" ? "pass" : "fail"}`,
    `okxRefresh=${okxRefresh}`,
    `okxHeartbeat=${okxHeartbeat}`,
    `okxContract=${okxContract}`,
    `localExecutorDispatch=${localExecutorDispatch}`,
    `positionSnapshot=${positionSnapshot}`,
    `executeRequired=${executeRequired}`,
    `noOrderWriteCount=${noOrderWriteCount}`,
    `summary=${summaryZhTw.length > 0 ? "present" : "missing"}`,
    `report=${reportPath}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    reportRead: Boolean(reportRead),
    messageTokenCounts: {
      okxRefresh,
      okxHeartbeat,
      okxContract,
      localExecutorDispatch,
      positionSnapshot,
      executeRequired,
      noOrderWrite: noOrderWriteCount,
    },
    summaryZhTw,
    noOrderWrite,
    reportPath,
    machineLine,
  };
}

function buildOkxSchedulerNoOrderContractProbeClosure({
  currentReadinessReport,
  refreshWorkflowReport,
  heartbeatOperationReport,
}) {
  const reports = {
    currentReadiness: okxSchedulerNoOrderReportStatus(currentReadinessReport),
    refreshWorkflow: okxSchedulerNoOrderReportStatus(refreshWorkflowReport),
    heartbeatOperation: okxSchedulerNoOrderReportStatus(heartbeatOperationReport),
  };
  const reportEntries = Object.entries(reports);
  const readyReports = reportEntries.filter(([, status]) => status.ready).length;
  const firstSchedulerNextRunAt =
    reportEntries
      .map(([, status]) => status.schedulerNextRunAt)
      .find((value) => value.length > 0) ?? "unavailable";
  const noOrderWrite = readyReports === reportEntries.length;
  const status = noOrderWrite ? "ready" : "blocked";
  const machineLine = [
    `okxSchedulerNoOrderContract=${status === "ready" ? "pass" : "fail"}`,
    `reports=${readyReports}/${reportEntries.length}`,
    `schedulerNextRunAt=${firstSchedulerNextRunAt}`,
    `current=${reports.currentReadiness.ready ? "pass" : "fail"}`,
    `refresh=${reports.refreshWorkflow.ready ? "pass" : "fail"}`,
    `heartbeat=${reports.heartbeatOperation.ready ? "pass" : "fail"}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    reports,
    readyReports,
    expectedReports: reportEntries.length,
    schedulerNextRunAt: firstSchedulerNextRunAt,
    noOrderWrite,
    machineLine,
  };
}

function buildCapitalOperatorPacketClosure(report) {
  const reportRead = report && typeof report === "object";
  const safety = asObject(report?.safety);
  const readiness = asObject(report?.readiness);
  const adapterAck = asObject(report?.adapterAck);
  const applyReceipt = asObject(adapterAck.applyReceipt);
  const executionPayload = asObject(report?.executionPayload);
  const blockers = Array.isArray(report?.blockers) ? report.blockers.map(String) : [];
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const adapterApplyReceiptStatus =
    typeof applyReceipt.status === "string" && applyReceipt.status.length > 0
      ? applyReceipt.status
      : (machineLine.match(/\badapterApplyReceipt=([^\s]+)/u)?.[1] ?? "unknown");
  const adapterApplyReceiptVerified =
    applyReceipt.verified === true || machineLine.includes("adapterApplyReceiptVerified=true");
  const noOrderWrite =
    safety.noOrderWrite === true ||
    safety.no_live_order_sent === true ||
    machineLine.includes("noOrderWrite=true");
  const sentOrder =
    safety.sentOrder === true ||
    safety.brokerWriteAttempted === true ||
    machineLine.includes("sentOrder=true");
  const operatorCanExecute =
    report?.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true");
  const status =
    reportRead && noOrderWrite && !sentOrder && !operatorCanExecute ? "visible_blocked" : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-capital-live-operator-execution-packet-latest.json";
  const derivedMachineLine =
    machineLine ||
    [
      `capitalOperatorPacket=${status}`,
      `operatorCanExecute=${operatorCanExecute}`,
      `readiness=${readiness.status ?? "unknown"}`,
      `adapterAck=${adapterAck.status ?? "unknown"}`,
      `adapterCanarySentOrder=${adapterAck.canarySentOrder === true}`,
      `adapterRollbackFresh=${adapterAck.rollbackFresh === true}`,
      `adapterApplyReceipt=${adapterApplyReceiptStatus}`,
      `adapterApplyReceiptVerified=${adapterApplyReceiptVerified}`,
      `dispatch=${executionPayload.dispatchPolicy ?? "unknown"}`,
      `report=${reportPath}`,
      `noOrderWrite=${noOrderWrite}`,
      `sentOrder=${sentOrder}`,
    ].join(" ");
  return {
    status,
    reportRead: Boolean(reportRead),
    operatorCanExecute,
    noOrderWrite,
    sentOrder,
    readinessStatus: readiness.status ?? "unknown",
    adapterAckStatus: adapterAck.status ?? "unknown",
    adapterCanarySentOrder: adapterAck.canarySentOrder === true,
    adapterRollbackFresh: adapterAck.rollbackFresh === true,
    adapterRollbackFreshnessStatus: adapterAck.rollbackFreshnessStatus ?? "unknown",
    adapterRollbackAgeSeconds: adapterAck.rollbackAgeSeconds ?? null,
    adapterApplyReceiptStatus,
    adapterApplyReceiptVerified,
    adapterApplyReceiptAction: applyReceipt.action ?? "",
    adapterApplyReceiptOperatorMayApply: applyReceipt.operatorMayApply === true,
    adapterApplyReceiptOperatorApplyVerified: applyReceipt.operatorApplyVerified === true,
    adapterApplyReceiptNextSafeTask: applyReceipt.nextSafeTask ?? "",
    dispatchPolicy: executionPayload.dispatchPolicy ?? "unknown",
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 10),
    reportPath,
    machineLine: derivedMachineLine,
  };
}

function buildCapitalLocalExecutorDispatchClosure(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.local-broker-executor-dispatch-contract.v1";
  const safety = asObject(report?.safety);
  const executor = asObject(report?.executor);
  const dispatchContract = asObject(report?.dispatchContract);
  const sealedOrderIntent = asObject(dispatchContract.sealedOrderIntent);
  const blockers = Array.isArray(report?.blockers) ? report.blockers.map(String) : [];
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const dispatchStatus =
    machineLine.match(/\bcapitalLocalExecutorDispatch=([^\s｜|]+)/u)?.[1] ??
    report?.status ??
    "missing";
  const dispatchPolicy =
    report?.dispatchPolicy ?? machineLine.match(/\bdispatchPolicy=([^\s｜|]+)/u)?.[1] ?? "unknown";
  const operatorCanExecute =
    report?.operatorPacket?.operatorCanExecute === true ||
    machineLine.includes("operatorCanExecute=true");
  const executorArmed = executor.armed === true || machineLine.includes("executorArmed=true");
  const noOrderWrite =
    safety.noLiveOrderSent === true ||
    safety.no_live_order_sent === true ||
    safety.brokerApiCalled === false ||
    machineLine.includes("noOrderWrite=true");
  const sentOrder =
    safety.sentOrder === true ||
    safety.brokerWriteAttempted === true ||
    dispatchContract.brokerApiCalled === true ||
    machineLine.includes("sentOrder=true");
  const reportPath =
    "reports/hermes-agent/state/openclaw-capital-local-broker-executor-dispatch-contract-latest.json";
  const derivedMachineLine =
    machineLine ||
    [
      `capitalLocalExecutorDispatch=${dispatchStatus}`,
      `sha256=${report?.sealedIntentSha256 ?? sealedOrderIntent.sha256 ?? "missing"}`,
      `operatorCanExecute=${operatorCanExecute}`,
      `executorArmed=${executorArmed}`,
      `dispatchPolicy=${dispatchPolicy}`,
      `payloadHash=${dispatchContract.payloadHash ?? "missing"}`,
      `noOrderWrite=${noOrderWrite}`,
      `sentOrder=${sentOrder}`,
      `blockers=${blockers.length}`,
    ].join(" ");
  return {
    status:
      reportRead && noOrderWrite && !sentOrder && !operatorCanExecute && !executorArmed
        ? "visible_blocked"
        : "blocked",
    reportRead: Boolean(reportRead),
    dispatchStatus,
    dispatchPolicy,
    operatorCanExecute,
    executorArmed,
    noOrderWrite,
    sentOrder,
    sealedOrderIntentSha256: report?.sealedIntentSha256 ?? sealedOrderIntent.sha256 ?? "",
    payloadHash: dispatchContract.payloadHash ?? "",
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 10),
    reportPath,
    machineLine: derivedMachineLine,
  };
}

function buildCapitalLiveExecutorArmProfileClosure(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.live-executor-arm-profile.v1";
  const requirements = asObject(report?.requirements);
  const observed = asObject(report?.profileRequirementsObserved);
  const safety = asObject(report?.safety);
  const paths = asObject(report?.paths);
  const blockers = Array.isArray(report?.blockers) ? report.blockers.map(String) : [];
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const requirementKeys = [
    "killSwitch",
    "canaryRequired",
    "rollbackRequired",
    "freshQuoteRequired",
    "verifiedPositionRequired",
    "adapterAckHashRequired",
  ];
  const requiredCount = requirementKeys.filter((key) => requirements[key] === true).length;
  const observedCount = requirementKeys.filter(
    (key) => requirements[key] === true && observed[key] === true,
  ).length;
  const armed = report?.armed === true || machineLine.includes("armed=true");
  const allowExecutorWrite =
    report?.allowExecutorWrite === true ||
    report?.allowBrokerWriteWhenAllGatesPass === true ||
    machineLine.includes("allowExecutorWrite=true");
  const noOrderWrite =
    safety.noLiveOrderSent === true ||
    safety.reportOnly === true ||
    machineLine.includes("noOrderWrite=true");
  const sentOrder = safety.sentOrder === true || machineLine.includes("sentOrder=true");
  const reportPath =
    "reports/hermes-agent/state/openclaw-capital-live-executor-arm-profile-latest.json";
  const derivedMachineLine =
    machineLine ||
    [
      `capitalLiveExecutorArmProfile=${report?.status ?? "missing"}`,
      `armed=${armed}`,
      `allowExecutorWrite=${allowExecutorWrite}`,
      `observed=${observedCount}/${requiredCount}`,
      `noOrderWrite=${noOrderWrite}`,
      `sentOrder=${sentOrder}`,
      `blockers=${blockers.length}`,
    ].join(" ");
  return {
    status: reportRead && noOrderWrite && !sentOrder ? "visible_unarmed" : "blocked",
    reportRead: Boolean(reportRead),
    profileStatus: report?.status ?? "missing",
    profileExists: report?.profileExists === true,
    profileReadStatus: report?.profileReadStatus ?? "unknown",
    armed,
    allowExecutorWrite,
    allowConversationAgentDirectWrite: report?.allowConversationAgentDirectWrite === true,
    expired: report?.expired === true,
    observedRequirementCount: observedCount,
    requiredRequirementCount: requiredCount,
    allRequirementsObserved: requiredCount > 0 && observedCount === requiredCount,
    noOrderWrite,
    sentOrder,
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 10),
    profilePath: paths.profilePath ?? "",
    templatePath: paths.templatePath ?? "",
    reportPath,
    machineLine: derivedMachineLine,
  };
}

function buildCapitalTradeAutoCycleClosure(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.trade-auto-cycle.v1";
  const summary = asObject(report?.summary);
  const decision = asObject(report?.decision);
  const safety = asObject(report?.safety);
  const promotionBlockerDiagnostics = asObject(report?.promotionBlockerDiagnostics);
  const steps = Array.isArray(report?.steps) ? report.steps.map((step) => asObject(step)) : [];
  const blockers = Array.isArray(report?.blockers) ? report.blockers.map(String) : [];
  const noLiveOrderSent =
    summary.noLiveOrderSent === true ||
    decision.noLiveOrderSent === true ||
    safety.noLiveOrderSent === true;
  const noOrderWrite =
    noLiveOrderSent &&
    safety.writeBrokerOrders === false &&
    safety.brokerWriteAttempted !== true &&
    safety.sentOrder !== true;
  const sentOrder = safety.sentOrder === true || safety.brokerWriteAttempted === true;
  const operatorCanExecute =
    summary.operatorCanExecute === true || decision.operatorCanExecute === true;
  const canTradeInsideOpenClaw = decision.canTradeInsideOpenClaw === true;
  const failedReplayQuoteDigestActiveSymbols = Array.isArray(
    summary.failedReplayQuoteDigestActiveSymbols,
  )
    ? summary.failedReplayQuoteDigestActiveSymbols
    : [];
  const failedReplayQuoteDigestUnlockedSymbols = Array.isArray(
    summary.failedReplayQuoteDigestUnlockedSymbols,
  )
    ? summary.failedReplayQuoteDigestUnlockedSymbols
    : [];
  const status =
    reportRead && noOrderWrite && !sentOrder && !operatorCanExecute && !canTradeInsideOpenClaw
      ? "visible_blocked_cycle"
      : "blocked";
  const reportPath = "reports/hermes-agent/state/openclaw-capital-trade-auto-cycle-latest.json";
  const machineLine = [
    `capitalTradeAutoCycle=${report?.status ?? "missing"}`,
    `decision=${decision.status ?? "unknown"}`,
    `quote=${summary.quoteFreshness ?? "unknown"}`,
    `a50=${summary.a50Status ?? "unknown"}`,
    `position=${summary.positionDecisionStatus ?? "unknown"}`,
    `adapterAck=${summary.externalBrokerAdapterAckStatus ?? "unknown"}`,
    `adapterHashOk=${summary.adapterAckHashOk === true}`,
    `adapterExpected=${summary.adapterAckExpectedSealedIntentSha256 ?? "missing"}`,
    `adapterActual=${summary.adapterAckActualSealedIntentSha256 ?? "missing"}`,
    `positionFreshness=${summary.verifiedPositionFreshnessStatus ?? "unknown"}`,
    `positionAge=${summary.verifiedPositionAgeSeconds ?? "missing"}`,
    `positionMaxFresh=${summary.verifiedPositionMaxFreshSeconds ?? "missing"}`,
    `strategyFillGate=${summary.strategyFillGate ?? "unknown"}`,
    `promotion=${summary.promotionBlockerStatus ?? "unknown"}`,
    `freshCandidates=${summary.freshPaperCandidateCollectorStatus ?? "unknown"}`,
    `freshCandidateCount=${summary.freshPaperCandidateCount ?? 0}`,
    `failedReplayDigest=${summary.failedReplayQuoteDigestGateStatus ?? "unknown"}`,
    `failedReplayActive=${failedReplayQuoteDigestActiveSymbols.join("|") || "none"}`,
    `failedReplayUnlocked=${failedReplayQuoteDigestUnlockedSymbols.join("|") || "none"}`,
    `freshSameCase=${summary.freshCandidateSameCaseRerunStatus ?? "unknown"}`,
    `freshSameCaseP05=${summary.freshCandidateSameCaseRerunP05Pts ?? "missing"}`,
    `oppositeExposure=${summary.oppositeExposurePaperRerunStatus ?? "unknown"}`,
    `oppositeP05=${summary.oppositeExposurePaperRerunP05Pts ?? "missing"}`,
    `evaluator=${summary.evaluatorRecommendation ?? "unknown"}`,
    `dispatch=${summary.dispatchPolicy ?? "unknown"}`,
    `operatorCanExecute=${operatorCanExecute}`,
    `canTradeInsideOpenClaw=${canTradeInsideOpenClaw}`,
    `steps=${steps.length}`,
    `blockers=${blockers.length}`,
    `report=${reportPath}`,
    `noLiveOrderSent=${noLiveOrderSent}`,
    `noOrderWrite=${noOrderWrite}`,
    `sentOrder=${sentOrder}`,
    `promotionBlockers=${promotionBlockerDiagnostics.machineLine ?? "missing"}`,
  ].join(" ");
  return {
    status,
    reportRead: Boolean(reportRead),
    reportStatus: report?.status ?? "unknown",
    decisionStatus: decision.status ?? "unknown",
    sealedOrderIntentSha256: summary.sealedOrderIntentSha256 ?? "",
    quoteFreshness: summary.quoteFreshness ?? "unknown",
    a50Status: summary.a50Status ?? "unknown",
    positionDecisionStatus: summary.positionDecisionStatus ?? "unknown",
    externalBrokerAdapterAckStatus: summary.externalBrokerAdapterAckStatus ?? "unknown",
    strategyFillGate: summary.strategyFillGate ?? "unknown",
    promotionBlockerStatus: summary.promotionBlockerStatus ?? "unknown",
    promotionBlockerFirst: summary.promotionBlockerFirst ?? "unknown",
    promotionBlockerNextAction: summary.promotionBlockerNextAction ?? "",
    promotionBlockerMachineLine: promotionBlockerDiagnostics.machineLine ?? "",
    adapterAckBlockerStatus: summary.adapterAckBlockerStatus ?? "unknown",
    adapterAckBlockerNextAction: summary.adapterAckBlockerNextAction ?? "",
    adapterAckHashOk: summary.adapterAckHashOk === true,
    adapterAckExpectedSealedIntentSha256: summary.adapterAckExpectedSealedIntentSha256 ?? "",
    adapterAckActualSealedIntentSha256: summary.adapterAckActualSealedIntentSha256 ?? "",
    adapterAckBlockerMachineLine: summary.adapterAckBlockerMachineLine ?? "",
    verifiedPositionBlockerStatus: summary.verifiedPositionBlockerStatus ?? "unknown",
    verifiedPositionBlockerNextAction: summary.verifiedPositionBlockerNextAction ?? "",
    verifiedPositionSnapshotStatus: summary.verifiedPositionSnapshotStatus ?? "",
    verifiedPositionFreshnessStatus: summary.verifiedPositionFreshnessStatus ?? "",
    verifiedPositionAgeSeconds: summary.verifiedPositionAgeSeconds ?? null,
    verifiedPositionMaxFreshSeconds: summary.verifiedPositionMaxFreshSeconds ?? null,
    verifiedPositionBlockerMachineLine: summary.verifiedPositionBlockerMachineLine ?? "",
    freshPaperCandidateCollectorStatus: summary.freshPaperCandidateCollectorStatus ?? "unknown",
    freshPaperCandidateCount: summary.freshPaperCandidateCount ?? 0,
    failedReplayQuoteDigestGateStatus: summary.failedReplayQuoteDigestGateStatus ?? "unknown",
    failedReplayQuoteDigestActiveSymbols,
    failedReplayQuoteDigestUnlockedSymbols,
    failedReplayQuoteDigestMachineLine: summary.failedReplayQuoteDigestMachineLine ?? "",
    freshCandidateSameCaseRerunStatus: summary.freshCandidateSameCaseRerunStatus ?? "unknown",
    freshCandidateSameCaseRerunPassCount: summary.freshCandidateSameCaseRerunPassCount ?? 0,
    freshCandidateSameCaseRerunP05Pts: summary.freshCandidateSameCaseRerunP05Pts ?? null,
    oppositeExposurePaperRerunStatus: summary.oppositeExposurePaperRerunStatus ?? "unknown",
    oppositeExposurePaperRerunPassCount: summary.oppositeExposurePaperRerunPassCount ?? 0,
    oppositeExposurePaperRerunP05Pts: summary.oppositeExposurePaperRerunP05Pts ?? null,
    evaluatorRecommendation: summary.evaluatorRecommendation ?? "unknown",
    dispatchPolicy: summary.dispatchPolicy ?? "unknown",
    operatorCanExecute,
    canTradeInsideOpenClaw,
    noLiveOrderSent,
    noOrderWrite,
    sentOrder,
    stepCount: steps.length,
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 10),
    nextSafeTask: typeof report?.nextSafeTask === "string" ? report.nextSafeTask : "",
    reportPath,
    machineLine,
  };
}

function buildCapitalTailRiskRepairClosure(platformReport, latestRepairReport) {
  const latestRepair = asObject(latestRepairReport);
  const latestRepairRead =
    latestRepair.schema === "openclaw.capital.strategy-tail-risk-repair-plan.v1";
  const reportRead =
    Boolean(platformReport && typeof platformReport === "object") || latestRepairRead;
  const strategy = asObject(platformReport?.strategy);
  const repair = latestRepairRead ? latestRepair : asObject(strategy.strategyTailRiskRepair);
  const plan = asObject(repair.repairCandidatePlan);
  const nextPaperCandidateBatch = asObject(plan.nextPaperCandidateBatch);
  const candidateQualityEvidence = asObject(nextPaperCandidateBatch.candidateQualityEvidence);
  const sameCaseRerunEvidence = asObject(nextPaperCandidateBatch.sameCaseRerunEvidence);
  const sameCaseReplayOutcome = asObject(sameCaseRerunEvidence.replayOutcome);
  const sameCaseSafetyLock = asObject(sameCaseRerunEvidence.safetyLock);
  const buckets = Array.isArray(plan.buckets)
    ? plan.buckets.map((bucket) => asObject(bucket)).filter(Boolean)
    : [];
  const bucketIds = buckets.map((bucket) => String(bucket.id ?? "")).filter(Boolean);
  const nextBatchSymbols = Array.isArray(nextPaperCandidateBatch.selectedSymbols)
    ? nextPaperCandidateBatch.selectedSymbols.map((symbol) => String(symbol ?? "")).filter(Boolean)
    : [];
  const excludedFailedReplaySymbols = Array.isArray(
    nextPaperCandidateBatch.excludedFailedReplaySymbols,
  )
    ? nextPaperCandidateBatch.excludedFailedReplaySymbols
        .map((symbol) => String(symbol ?? ""))
        .filter(Boolean)
    : [];
  const skippedFailedReplayCandidateCount = Number(
    nextPaperCandidateBatch.skippedFailedReplayCandidateCount ?? 0,
  );
  const availableAfterExclusionCount = Number(
    nextPaperCandidateBatch.availableAfterExclusionCount ?? 0,
  );
  const sameCaseContributionRanking = Array.isArray(
    sameCaseRerunEvidence.candidateContributionRanking,
  )
    ? sameCaseRerunEvidence.candidateContributionRanking
        .map((candidate, index) => {
          const row = asObject(candidate);
          const symbol = String(row.symbol ?? "");
          if (!symbol) {
            return null;
          }
          const p05DragProxyNotional = Number(row.p05DragProxyNotional);
          return {
            rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
            symbol,
            p05DragProxyNotional: Number.isFinite(p05DragProxyNotional)
              ? p05DragProxyNotional
              : null,
            requiresSameCaseRerun: row.requiresSameCaseRerun === true,
          };
        })
        .filter(Boolean)
    : [];
  const sameCaseRankingLine = sameCaseContributionRanking
    .map(
      (candidate) =>
        `${candidate.rank}:${candidate.symbol}:${candidate.p05DragProxyNotional ?? "unknown"}`,
    )
    .join("|");
  const sameCaseMachineLine =
    typeof sameCaseRerunEvidence.machineLine === "string" ? sameCaseRerunEvidence.machineLine : "";
  const sameCaseFollowUpCommand =
    typeof sameCaseRerunEvidence.followUpCommand === "string"
      ? sameCaseRerunEvidence.followUpCommand
      : typeof nextPaperCandidateBatch.followUpCommand === "string"
        ? nextPaperCandidateBatch.followUpCommand
        : "";
  const repairNextCommand = asObject(repair.nextCommand);
  const riskNotionalReviewPlan = asObject(plan.riskNotionalReviewPlan);
  const nextCommand =
    typeof repairNextCommand.command === "string" && repairNextCommand.command.trim().length > 0
      ? repairNextCommand.command.trim()
      : sameCaseFollowUpCommand;
  const nextCommandId =
    typeof repairNextCommand.id === "string" && repairNextCommand.id.trim().length > 0
      ? repairNextCommand.id.trim()
      : "missing";
  const nextValidationCommand =
    typeof repairNextCommand.validationCommand === "string" &&
    repairNextCommand.validationCommand.trim().length > 0
      ? repairNextCommand.validationCommand.trim()
      : "";
  const nextCommandToken = nextCommand.replace(/^pnpm\s+/u, "").replace(/\s+/gu, "_");
  const nextValidationCommandToken = nextValidationCommand
    .replace(/^pnpm\s+/u, "")
    .replace(/\s+/gu, "_");
  const riskReviewStatus =
    typeof riskNotionalReviewPlan.status === "string" ? riskNotionalReviewPlan.status : "missing";
  const riskReviewActionableCount = numericCount(riskNotionalReviewPlan.actionableCandidateCount);
  const nextCommandMachineLine = [
    `capitalTailRiskNextCommand=${nextCommandId}`,
    `command=${nextCommandToken || "missing"}`,
    `validation=${nextValidationCommandToken || "missing"}`,
    `repair=${repair.status ?? "missing"}`,
    `riskReview=${riskReviewStatus}`,
    `actionable=${riskReviewActionableCount}`,
  ].join(" ");
  const sameCaseNoOrderWrite =
    sameCaseRerunEvidence.noOrderWrite === true ||
    sameCaseSafetyLock.writeBrokerOrders === false ||
    sameCaseMachineLine.includes("noOrderWrite=true");
  const machineLine = typeof repair.machineLine === "string" ? repair.machineLine : "";
  const noOrderWrite = plan.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
  const status =
    reportRead && noOrderWrite && buckets.length >= 6 ? "visible_candidate_plan" : "blocked";
  const failedReplayHistoryMachineLine = [
    `capitalFailedReplayHistory=banned:${excludedFailedReplaySymbols.join("|") || "none"}`,
    `next=${nextBatchSymbols.join("|") || "none"}`,
    `skipped=${Number.isFinite(skippedFailedReplayCandidateCount) ? skippedFailedReplayCandidateCount : 0}`,
    `available=${Number.isFinite(availableAfterExclusionCount) ? availableAfterExclusionCount : 0}`,
    `sameCase=${sameCaseRerunEvidence.status ?? "missing"}`,
    `quality=${candidateQualityEvidence.status ?? "missing"}`,
    `source=${latestRepairRead ? "latest" : "platform"}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  const derivedMachineLine = [
    `capitalTailRiskRepair=${repair.status ?? "missing"}`,
    `candidatePlan=${plan.status ?? "missing"}`,
    `buckets=${buckets.length}`,
    `bucketIds=${bucketIds.join("/") || "none"}`,
    `nextBatch=${nextPaperCandidateBatch.status ?? "missing"}`,
    `nextBatchSelected=${nextBatchSymbols.join("|") || "none"}`,
    `excludedFailedReplay=${excludedFailedReplaySymbols.join("|") || "none"}`,
    `skippedFailedReplay=${
      Number.isFinite(skippedFailedReplayCandidateCount) ? skippedFailedReplayCandidateCount : 0
    }`,
    `availableAfterExclusion=${
      Number.isFinite(availableAfterExclusionCount) ? availableAfterExclusionCount : 0
    }`,
    `sameCase=${sameCaseRerunEvidence.status ?? "missing"}`,
    `ranked=${sameCaseRankingLine || "none"}`,
    `replayOutcome=${sameCaseReplayOutcome.status ?? "not_evaluated"}`,
    `replayP05=${sameCaseReplayOutcome.replayP05Pts ?? "missing"}`,
    `replayP05Notional=${sameCaseReplayOutcome.replayP05Notional ?? "missing"}`,
    `nextCommand=${nextCommandToken || "missing"}`,
    `nextCommandId=${nextCommandId}`,
    `riskReview=${riskReviewStatus}`,
    `riskReviewActionable=${riskReviewActionableCount}`,
    `followUpCommand=${sameCaseFollowUpCommand || "missing"}`,
    `failedReplayHistory=${failedReplayHistoryMachineLine}`,
    `noOrderWrite=${noOrderWrite}`,
    `sameCaseNoOrderWrite=${sameCaseNoOrderWrite}`,
  ].join(" ");
  return {
    status,
    reportRead: Boolean(reportRead),
    repairStatus: repair.status ?? "unknown",
    planStatus: plan.status ?? "unknown",
    bucketCount: buckets.length,
    bucketIds,
    nextBatchStatus: nextPaperCandidateBatch.status ?? "unknown",
    nextBatchSymbols,
    excludedFailedReplaySymbols,
    skippedFailedReplayCandidateCount: Number.isFinite(skippedFailedReplayCandidateCount)
      ? skippedFailedReplayCandidateCount
      : 0,
    availableAfterExclusionCount: Number.isFinite(availableAfterExclusionCount)
      ? availableAfterExclusionCount
      : 0,
    sameCaseRerunStatus: sameCaseRerunEvidence.status ?? "unknown",
    sameCaseContributionRanking,
    sameCaseRankingLine,
    sameCaseReplayOutcomeStatus: sameCaseReplayOutcome.status ?? "not_evaluated",
    sameCaseReplayP05Pts: sameCaseReplayOutcome.replayP05Pts ?? null,
    sameCaseReplayP05Notional: sameCaseReplayOutcome.replayP05Notional ?? null,
    nextCommand,
    nextCommandId,
    nextValidationCommand,
    nextCommandMachineLine,
    riskReviewStatus,
    riskReviewActionableCount,
    sameCaseFollowUpCommand,
    candidateQualityStatus: candidateQualityEvidence.status ?? "missing",
    failedReplayHistoryMachineLine,
    noOrderWrite,
    sameCaseNoOrderWrite,
    reportSource: latestRepairRead ? "latest_tail_risk_repair_report" : "platform_embedded_report",
    machineLine: derivedMachineLine,
  };
}

function buildCapitalRiskResizedRejectionClosure(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1";
  const rejectionSummary = asObject(report?.rejectionSummary);
  const safetyLock = asObject(report?.safetyLock);
  const summarySafetyLock = asObject(rejectionSummary.safetyLock);
  const rejectedCandidates = Array.isArray(rejectionSummary.rejectedCandidates)
    ? rejectionSummary.rejectedCandidates.map((candidate) => asObject(candidate)).filter(Boolean)
    : [];
  const rejectedSymbols = rejectedCandidates
    .map((candidate) => String(candidate.symbol ?? ""))
    .filter(Boolean);
  const p05PtsLine = rejectedCandidates
    .map(
      (candidate) =>
        `${String(candidate.symbol ?? "unknown")}:${candidate.p05TotalPnlPts ?? "missing"}`,
    )
    .join("|");
  const p05NotionalLine = rejectedCandidates
    .map(
      (candidate) =>
        `${String(candidate.symbol ?? "unknown")}:${candidate.p05TotalPnlNotional ?? "missing"}`,
    )
    .join("|");
  const reasonLine = [
    ...new Set(
      rejectedCandidates.flatMap((candidate) =>
        Array.isArray(candidate.rejectionReasons)
          ? candidate.rejectionReasons.map((reason) => String(reason ?? "")).filter(Boolean)
          : [],
      ),
    ),
  ].join("|");
  const passConditionsLine = Array.isArray(rejectionSummary.requiredPassConditions)
    ? rejectionSummary.requiredPassConditions.map((condition) => String(condition ?? "")).join("|")
    : "";
  const sourceMachineLine =
    typeof rejectionSummary.machineLine === "string" ? rejectionSummary.machineLine : "";
  const noOrderWrite =
    rejectionSummary.noOrderWrite === true ||
    report?.noOrderWrite === true ||
    safetyLock.writeBrokerOrders === false ||
    summarySafetyLock.writeBrokerOrders === false ||
    sourceMachineLine.includes("noOrderWrite=true");
  const sentOrder =
    safetyLock.sentOrder === true ||
    summarySafetyLock.sentOrder === true ||
    sourceMachineLine.includes("sentOrder=true");
  const nextCommand =
    typeof rejectionSummary.nextCommand === "string" ? rejectionSummary.nextCommand.trim() : "";
  const nextCommandToken = nextCommand.replace(/^pnpm\s+/u, "").replace(/\s+/gu, "_");
  const machineLine =
    sourceMachineLine ||
    [
      `riskResizedRejectionSummary=${rejectionSummary.status ?? "missing"}`,
      `rejected=${rejectedSymbols.join("|") || "none"}`,
      `pass=${Array.isArray(rejectionSummary.passedSymbols) ? rejectionSummary.passedSymbols.join("|") || "none" : "none"}`,
      `p05Pts=${p05PtsLine || "none"}`,
      `p05Notional=${p05NotionalLine || "none"}`,
      `next=${nextCommandToken || "missing"}`,
      `noOrderWrite=${noOrderWrite}`,
    ].join(";");
  const publishMachineLine = [
    `riskResizedRejectionSummary=${rejectionSummary.status ?? "missing"}`,
    `rejected=${rejectedSymbols.join("|") || "none"}`,
    `p05Pts=${p05PtsLine || "none"}`,
    `p05Notional=${p05NotionalLine || "none"}`,
    `reason=${reasonLine || "missing"}`,
    `next=${nextCommandToken || "missing"}`,
    "noOrderWrite:ok",
  ].join(";");
  const status =
    reportRead &&
    noOrderWrite &&
    !sentOrder &&
    machineLine.includes("riskResizedRejectionSummary=") &&
    machineLine.includes("p05Pts=") &&
    machineLine.includes("p05Notional=")
      ? "visible_rejection_summary"
      : "blocked";
  return {
    status,
    reportRead: Boolean(reportRead),
    summaryStatus: rejectionSummary.status ?? "missing",
    rejectedCount: numericCount(rejectionSummary.rejectedCount),
    passCount: numericCount(rejectionSummary.passCount),
    blockedCount: numericCount(rejectionSummary.blockedCount),
    rejectedSymbols,
    p05PtsLine,
    p05NotionalLine,
    reasonLine,
    passConditionsLine,
    nextCommand,
    noOrderWrite,
    sentOrder,
    machineLine,
    publishMachineLine,
    reportPath:
      "reports/hermes-agent/state/openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
  };
}

function buildCapitalHighConfidencePaperRerunClosure(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.high-confidence-paper-rerun-gate.v1";
  const confidenceGate = asObject(report?.confidenceGate);
  const safetyLock = asObject(report?.safetyLock);
  const machineLine = typeof report?.machineLine === "string" ? report.machineLine : "";
  const candidates = Array.isArray(report?.candidates)
    ? report.candidates.map((candidate) => asObject(candidate)).filter(Boolean)
    : [];
  const candidateSymbols = candidates
    .map((candidate) => String(candidate.symbol ?? ""))
    .filter(Boolean);
  const passCount = numericCount(report?.passCount);
  const blockedCount = numericCount(report?.blockedCount);
  const noOrderWrite =
    report?.noOrderWrite === true ||
    safetyLock.writeBrokerOrders === false ||
    safetyLock.noLiveOrderSent === true ||
    machineLine.includes("noOrderWrite=true");
  const sentOrder = safetyLock.sentOrder === true || machineLine.includes("sentOrder=true");
  const status =
    reportRead && noOrderWrite && !sentOrder && passCount === 0
      ? "visible_blocked"
      : reportRead && noOrderWrite && !sentOrder && passCount > 0
        ? "visible_passed"
        : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json";
  const derivedMachineLine =
    machineLine ||
    [
      `highConfidencePaperRerun=${report?.status ?? "missing"}`,
      `threshold=${confidenceGate.threshold ?? "missing"}`,
      `requiredConfidence=${confidenceGate.requiredConfidenceForPositiveP05 ?? "missing"}`,
      `candidates=${candidateSymbols.join("|") || "none"}`,
      `pass=${passCount}`,
      `blocked=${blockedCount}`,
      `noOrderWrite=${noOrderWrite}`,
    ].join(";");
  return {
    status,
    reportRead: Boolean(reportRead),
    gateStatus: report?.status ?? "unknown",
    threshold: confidenceGate.threshold ?? null,
    requiredConfidence: confidenceGate.requiredConfidenceForPositiveP05 ?? null,
    requiredConfidenceStatus: confidenceGate.requiredConfidenceStatus ?? "unknown",
    candidateCount: candidateSymbols.length,
    candidateSymbols,
    passCount,
    blockedCount,
    blockers: Array.isArray(report?.blockers) ? report.blockers.map(String).slice(0, 10) : [],
    noOrderWrite,
    sentOrder,
    reportPath,
    machineLine: derivedMachineLine,
  };
}

function buildCapitalVerifiedPositionSnapshotClosure(platformReport) {
  const reportRead = platformReport && typeof platformReport === "object";
  const positionDecision = asObject(platformReport?.positionDecision);
  const execution = asObject(platformReport?.execution);
  const activeTargets = asObject(execution.activeTargets);
  const activeSnapshot = asObject(activeTargets.verifiedPositionSnapshot);
  const safety = asObject(platformReport?.safety);
  const verifiedAgeSeconds = numericCount(
    positionDecision.verifiedAgeSeconds ?? activeSnapshot.verifiedAgeSeconds,
  );
  const maxFreshSeconds = numericCount(
    positionDecision.maxFreshSeconds ?? activeSnapshot.maxFreshSeconds ?? 43200,
  );
  const freshnessStatus = String(
    positionDecision.freshnessStatus ?? activeSnapshot.freshnessStatus ?? "unknown",
  );
  const decisionStatus = String(positionDecision.decisionStatus ?? "unknown");
  const usable = positionDecision.usable === true || activeSnapshot.usable === true;
  const fresh =
    usable &&
    freshnessStatus === "fresh" &&
    (maxFreshSeconds <= 0 || verifiedAgeSeconds <= maxFreshSeconds);
  const noOrderWrite =
    safety.noLiveOrderSent === true ||
    safety.no_live_order_sent === true ||
    safety.writeBrokerOrders === false ||
    execution.noLiveOrderSent === true;
  const sentOrder = safety.sentOrder === true || execution.sentOrder === true;
  const status = reportRead && fresh ? "fresh_verified" : "stale_operator_refresh_required";
  const machineLine = [
    `capitalVerifiedPositionSnapshot=${status}`,
    `decision=${decisionStatus}`,
    `freshness=${freshnessStatus}`,
    `age=${verifiedAgeSeconds}`,
    `maxFresh=${maxFreshSeconds}`,
    `hasOpenPosition=${positionDecision.hasOpenPosition === true}`,
    `net=${positionDecision.netContracts ?? 0}`,
    `path=${String(positionDecision.path ?? activeSnapshot.path ?? "missing")}`,
    `next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(";");
  return {
    status,
    reportRead: Boolean(reportRead),
    usable,
    decisionStatus,
    freshnessStatus,
    verifiedAgeSeconds,
    maxFreshSeconds,
    hasOpenPosition: positionDecision.hasOpenPosition === true,
    netContracts: positionDecision.netContracts ?? 0,
    path: String(positionDecision.path ?? activeSnapshot.path ?? "missing"),
    nextCommand: "pnpm capital:trade:direct:status:check",
    noOrderWrite,
    sentOrder,
    machineLine,
  };
}

function buildShortcutCheckCountClosure(checks) {
  const total = checks.length;
  const failed = checks.filter((check) => check.status !== "pass").length;
  const idIncludes = (check, value) => String(check.id ?? "").includes(value);
  const assistantClosureChecks = checks.filter((check) => idIncludes(check, "assistant")).length;
  const okxClosureChecks = checks.filter(
    (check) =>
      String(check.id ?? "").startsWith("okx-paper-audit:") ||
      String(check.id ?? "").startsWith("okx-current-readiness:") ||
      String(check.id ?? "").startsWith("okx-current-readiness-heartbeat-operation:") ||
      String(check.id ?? "").startsWith("okx-market-snapshot-scheduler:"),
  ).length;
  const fixtureCoverageChecks = checks.filter((check) => idIncludes(check, "fixture")).length;
  const reportMachineChecks = checks.filter(
    (check) =>
      idIncludes(check, "machine-line") ||
      idIncludes(check, "machine-summary") ||
      String(check.summaryKey ?? "").endsWith(".machineLine"),
  ).length;
  const machineLine = [
    `shortcutChecks=${total}`,
    `failed=${failed}`,
    `assistantClosure=${assistantClosureChecks}`,
    `okxClosure=${okxClosureChecks}`,
    `fixtureCoverage=${fixtureCoverageChecks}`,
    `reportMachine=${reportMachineChecks}`,
    "growthReason=assistant+okx+fixture+report-machine",
  ].join(" ");
  return {
    total,
    failed,
    assistantClosureChecks,
    okxClosureChecks,
    fixtureCoverageChecks,
    reportMachineChecks,
    machineLine,
  };
}

function renderMarkdownSummary(report) {
  const assistantClosure = report.summary.assistantClosure;
  const learningSummaryClosure = report.summary.learningSummaryClosure ?? {};
  const okxPaperAuditClosure = report.summary.okxPaperAuditClosure ?? {};
  const okxCurrentReadinessClosure = report.summary.okxCurrentReadinessClosure ?? {};
  const okxCurrentReadinessHeartbeatOperationClosure =
    report.summary.okxCurrentReadinessHeartbeatOperationClosure ?? {};
  const okxCurrentReadinessRefreshWorkflowClosure =
    report.summary.okxCurrentReadinessRefreshWorkflowClosure ?? {};
  const okxCurrentReadinessInventoryProbeClosure =
    report.summary.okxCurrentReadinessInventoryProbeClosure ?? {};
  const okxHeartbeatPublishTokenCountClosure =
    report.summary.okxHeartbeatPublishTokenCountClosure ?? {};
  const capitalOperatorPacketClosure = report.summary.capitalOperatorPacketClosure ?? {};
  const capitalLocalExecutorDispatchClosure =
    report.summary.capitalLocalExecutorDispatchClosure ?? {};
  const capitalLiveExecutorArmProfileClosure =
    report.summary.capitalLiveExecutorArmProfileClosure ?? {};
  const capitalTradeAutoCycleClosure = report.summary.capitalTradeAutoCycleClosure ?? {};
  const capitalTailRiskRepairClosure = report.summary.capitalTailRiskRepairClosure ?? {};
  const capitalRiskResizedRejectionClosure =
    report.summary.capitalRiskResizedRejectionClosure ?? {};
  const capitalHighConfidencePaperRerunClosure =
    report.summary.capitalHighConfidencePaperRerunClosure ?? {};
  const capitalVerifiedPositionSnapshotClosure =
    report.summary.capitalVerifiedPositionSnapshotClosure ?? {};
  const shortcutCheckCountClosure = report.summary.shortcutCheckCountClosure ?? {};
  const paperLoopLearningRefresh = assistantClosure.paperLoopLearningRefresh ?? {};
  const assistantLearningHint = assistantClosure.assistantLearningHint ?? {};
  const assistantNextCommandShortRow =
    assistantLearningHint.nextCommandShortRow &&
    typeof assistantLearningHint.nextCommandShortRow === "object"
      ? assistantLearningHint.nextCommandShortRow
      : {};
  const fixtureCoverage =
    report.summary.fixtureCoverage ?? buildFixtureCoverageSummary(report.checks);
  const statusStripFixtureCoverage = assistantClosure.statusStripFixtureCoverage ?? fixtureCoverage;
  const okxSchedulerNoOrderContractProbeClosure =
    report.summary.okxSchedulerNoOrderContractProbeClosure ?? {};
  const statusStripFixtureCoverageTargets = Array.isArray(statusStripFixtureCoverage.targets)
    ? statusStripFixtureCoverage.targets.join(" / ")
    : "";
  const fixtureCoverageTargets = fixtureCoverage.targets.join(" / ");
  return [
    "# OpenClaw Telegram Trading Shortcuts Summary",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${report.status}`,
    `shortcuts: ${report.summary.shortcuts}`,
    `checks: ${report.summary.checks}`,
    `checkCountMachineLine: ${shortcutCheckCountClosure.machineLine ?? ""}`,
    `failed: ${report.summary.failed}`,
    `fixtureCoverage: ${fixtureCoverage.status} ${fixtureCoverageTargets}`.trim(),
    "",
    "## OKX Paper Audit Closure",
    "",
    `machineLine: ${okxPaperAuditClosure.machineLine ?? ""}`,
    `platformSnapshotRead: ${renderFlag(okxPaperAuditClosure.platformSnapshotRead)}`,
    `platformVisible: ${renderFlag(okxPaperAuditClosure.platformVisible)}`,
    `okxStatusRead: ${renderFlag(okxPaperAuditClosure.okxStatusRead)}`,
    `okxStatusVisible: ${renderFlag(okxPaperAuditClosure.okxStatusVisible)}`,
    `noOrderWrite: ${renderFlag(okxPaperAuditClosure.noOrderWrite)}`,
    "",
    "## OKX Current Readiness Closure",
    "",
    `machineLine: ${okxCurrentReadinessClosure.machineLine ?? ""}`,
    `okxStatusRead: ${renderFlag(okxCurrentReadinessClosure.okxStatusRead)}`,
    `okxStatusVisible: ${renderFlag(okxCurrentReadinessClosure.okxStatusVisible)}`,
    `assistantSummaryRead: ${renderFlag(okxCurrentReadinessClosure.assistantSummaryRead)}`,
    `assistantStatusStripVisible: ${renderFlag(
      okxCurrentReadinessClosure.assistantStatusStripVisible,
    )}`,
    `noOrderWrite: ${renderFlag(okxCurrentReadinessClosure.noOrderWrite)}`,
    "",
    "## OKX Current Readiness Refresh Workflow Closure",
    "",
    `machineLine: ${okxCurrentReadinessRefreshWorkflowClosure.machineLine ?? ""}`,
    `steps: ${okxCurrentReadinessRefreshWorkflowClosure.passedSteps ?? 0}/${okxCurrentReadinessRefreshWorkflowClosure.totalSteps ?? 0}`,
    `failedSteps: ${
      Array.isArray(okxCurrentReadinessRefreshWorkflowClosure.failedSteps)
        ? okxCurrentReadinessRefreshWorkflowClosure.failedSteps.join(" / ") || "none"
        : "none"
    }`,
    `latestRefreshRun: ${
      okxCurrentReadinessRefreshWorkflowClosure.latestRefreshRunStatus ?? ""
    }/${okxCurrentReadinessRefreshWorkflowClosure.latestRefreshRunExitCode ?? ""}`,
    `reportRead: ${renderFlag(okxCurrentReadinessRefreshWorkflowClosure.reportRead)}`,
    `assistantStatusStripVisible: ${renderFlag(
      okxCurrentReadinessRefreshWorkflowClosure.assistantStatusStripVisible,
    )}`,
    `noOrderWrite: ${renderFlag(okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite)}`,
    "",
    "## OKX Current Readiness Inventory Probe Closure",
    "",
    `machineLine: ${okxCurrentReadinessInventoryProbeClosure.machineLine ?? ""}`,
    `summaryProbes: ${okxCurrentReadinessInventoryProbeClosure.summaryProbeCount ?? 0}/${okxCurrentReadinessInventoryProbeClosure.summaryProbeExpectedCount ?? 0}`,
    `publishProbes: ${okxCurrentReadinessInventoryProbeClosure.publishProbeCount ?? 0}/${okxCurrentReadinessInventoryProbeClosure.publishProbeExpectedCount ?? 0}`,
    `missingTokens: ${
      Array.isArray(okxCurrentReadinessInventoryProbeClosure.missingTokens)
        ? okxCurrentReadinessInventoryProbeClosure.missingTokens.join(" / ") || "none"
        : ""
    }`,
    `noOrderWrite: ${renderFlag(okxCurrentReadinessInventoryProbeClosure.noOrderWrite)}`,
    "",
    "## OKX Heartbeat Publish Token Count Closure",
    "",
    `machineLine: ${okxHeartbeatPublishTokenCountClosure.machineLine ?? ""}`,
    `summaryZhTw: ${okxHeartbeatPublishTokenCountClosure.summaryZhTw ?? ""}`,
    `noOrderWrite: ${renderFlag(okxHeartbeatPublishTokenCountClosure.noOrderWrite)}`,
    "",
    "## OKX Scheduler No-Order Contract Probe",
    "",
    `machineLine: ${okxSchedulerNoOrderContractProbeClosure.machineLine ?? ""}`,
    `schedulerNextRunAt: ${okxSchedulerNoOrderContractProbeClosure.schedulerNextRunAt ?? ""}`,
    `readyReports: ${okxSchedulerNoOrderContractProbeClosure.readyReports ?? 0}/${okxSchedulerNoOrderContractProbeClosure.expectedReports ?? 0}`,
    `noOrderWrite: ${renderFlag(okxSchedulerNoOrderContractProbeClosure.noOrderWrite)}`,
    "",
    "## OKX Current Readiness Heartbeat Operation Closure",
    "",
    `machineLine: ${okxCurrentReadinessHeartbeatOperationClosure.machineLine ?? ""}`,
    `nextSafeTask: ${okxCurrentReadinessHeartbeatOperationClosure.nextSafeTask ?? ""}`,
    `telegramCallback: ${okxCurrentReadinessHeartbeatOperationClosure.telegramCallback ?? ""}`,
    `refreshCommand: ${okxCurrentReadinessHeartbeatOperationClosure.refreshCommand ?? ""}`,
    `oneClickRefresh: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.oneClickRefresh)}`,
    `reportRead: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.reportRead)}`,
    `assistantStatusStripVisible: ${renderFlag(
      okxCurrentReadinessHeartbeatOperationClosure.assistantStatusStripVisible,
    )}`,
    `commandsVisible: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.commandsVisible)}`,
    `inventoryProbeStatus: ${okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeStatus ?? ""}`,
    `inventoryProbeReady: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeReady)}`,
    `inventoryProbeMachineLine: ${okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeMachineLine ?? ""}`,
    `inventoryProbeNoOrderWrite: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeNoOrderWrite)}`,
    `publishBridgeStatusReady: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.publishBridgeStatusReady)}`,
    `publishBridgeMachineLine: ${okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine ?? ""}`,
    `upstreamNoOrderWriteVerified: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteVerified)}`,
    `upstreamNoOrderWriteCount: ${okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteCount ?? ""}`,
    `upstreamExecuteRequiredCount: ${okxCurrentReadinessHeartbeatOperationClosure.upstreamExecuteRequiredCount ?? ""}`,
    `noOrderWrite: ${renderFlag(okxCurrentReadinessHeartbeatOperationClosure.noOrderWrite)}`,
    "",
    "## Capital Operator Packet Closure",
    "",
    `machineLine: ${capitalOperatorPacketClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalOperatorPacketClosure.reportRead)}`,
    `operatorCanExecute: ${renderFlag(capitalOperatorPacketClosure.operatorCanExecute)}`,
    `readinessStatus: ${capitalOperatorPacketClosure.readinessStatus ?? ""}`,
    `adapterAckStatus: ${capitalOperatorPacketClosure.adapterAckStatus ?? ""}`,
    `adapterCanarySentOrder: ${renderFlag(capitalOperatorPacketClosure.adapterCanarySentOrder)}`,
    `adapterRollbackFresh: ${renderFlag(capitalOperatorPacketClosure.adapterRollbackFresh)}`,
    `adapterRollbackFreshnessStatus: ${capitalOperatorPacketClosure.adapterRollbackFreshnessStatus ?? ""}`,
    `adapterRollbackAgeSeconds: ${capitalOperatorPacketClosure.adapterRollbackAgeSeconds ?? ""}`,
    `adapterApplyReceiptStatus: ${capitalOperatorPacketClosure.adapterApplyReceiptStatus ?? ""}`,
    `adapterApplyReceiptVerified: ${renderFlag(
      capitalOperatorPacketClosure.adapterApplyReceiptVerified,
    )}`,
    `adapterApplyReceiptAction: ${capitalOperatorPacketClosure.adapterApplyReceiptAction ?? ""}`,
    `adapterApplyReceiptOperatorMayApply: ${renderFlag(
      capitalOperatorPacketClosure.adapterApplyReceiptOperatorMayApply,
    )}`,
    `adapterApplyReceiptNextSafeTask: ${capitalOperatorPacketClosure.adapterApplyReceiptNextSafeTask ?? ""}`,
    `dispatchPolicy: ${capitalOperatorPacketClosure.dispatchPolicy ?? ""}`,
    `noOrderWrite: ${renderFlag(capitalOperatorPacketClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalOperatorPacketClosure.sentOrder)}`,
    "",
    "## Capital Local Executor Dispatch Closure",
    "",
    `machineLine: ${capitalLocalExecutorDispatchClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalLocalExecutorDispatchClosure.reportRead)}`,
    `dispatchStatus: ${capitalLocalExecutorDispatchClosure.dispatchStatus ?? ""}`,
    `dispatchPolicy: ${capitalLocalExecutorDispatchClosure.dispatchPolicy ?? ""}`,
    `operatorCanExecute: ${renderFlag(capitalLocalExecutorDispatchClosure.operatorCanExecute)}`,
    `executorArmed: ${renderFlag(capitalLocalExecutorDispatchClosure.executorArmed)}`,
    `sealedOrderIntentSha256: ${capitalLocalExecutorDispatchClosure.sealedOrderIntentSha256 ?? ""}`,
    `noOrderWrite: ${renderFlag(capitalLocalExecutorDispatchClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalLocalExecutorDispatchClosure.sentOrder)}`,
    "",
    "## Capital Live Executor Arm Profile Closure",
    "",
    `machineLine: ${capitalLiveExecutorArmProfileClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalLiveExecutorArmProfileClosure.reportRead)}`,
    `profileStatus: ${capitalLiveExecutorArmProfileClosure.profileStatus ?? ""}`,
    `profileExists: ${renderFlag(capitalLiveExecutorArmProfileClosure.profileExists)}`,
    `armed: ${renderFlag(capitalLiveExecutorArmProfileClosure.armed)}`,
    `allowExecutorWrite: ${renderFlag(capitalLiveExecutorArmProfileClosure.allowExecutorWrite)}`,
    `observedRequirements: ${capitalLiveExecutorArmProfileClosure.observedRequirementCount ?? 0}/${capitalLiveExecutorArmProfileClosure.requiredRequirementCount ?? 0}`,
    `noOrderWrite: ${renderFlag(capitalLiveExecutorArmProfileClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalLiveExecutorArmProfileClosure.sentOrder)}`,
    "",
    "## Capital Trade Auto Cycle Closure",
    "",
    `machineLine: ${capitalTradeAutoCycleClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalTradeAutoCycleClosure.reportRead)}`,
    `reportStatus: ${capitalTradeAutoCycleClosure.reportStatus ?? ""}`,
    `decisionStatus: ${capitalTradeAutoCycleClosure.decisionStatus ?? ""}`,
    `sealedOrderIntentSha256: ${capitalTradeAutoCycleClosure.sealedOrderIntentSha256 ?? ""}`,
    `quoteFreshness: ${capitalTradeAutoCycleClosure.quoteFreshness ?? ""}`,
    `a50Status: ${capitalTradeAutoCycleClosure.a50Status ?? ""}`,
    `positionDecisionStatus: ${capitalTradeAutoCycleClosure.positionDecisionStatus ?? ""}`,
    `externalBrokerAdapterAckStatus: ${
      capitalTradeAutoCycleClosure.externalBrokerAdapterAckStatus ?? ""
    }`,
    `strategyFillGate: ${capitalTradeAutoCycleClosure.strategyFillGate ?? ""}`,
    `promotionBlockerStatus: ${capitalTradeAutoCycleClosure.promotionBlockerStatus ?? ""}`,
    `promotionBlockerFirst: ${capitalTradeAutoCycleClosure.promotionBlockerFirst ?? ""}`,
    `promotionBlockerNextAction: ${capitalTradeAutoCycleClosure.promotionBlockerNextAction ?? ""}`,
    `promotionBlockerMachineLine: ${
      capitalTradeAutoCycleClosure.promotionBlockerMachineLine ?? ""
    }`,
    `adapterAckBlockerStatus: ${capitalTradeAutoCycleClosure.adapterAckBlockerStatus ?? ""}`,
    `adapterAckHashOk: ${renderFlag(capitalTradeAutoCycleClosure.adapterAckHashOk)}`,
    `adapterAckBlockerMachineLine: ${
      capitalTradeAutoCycleClosure.adapterAckBlockerMachineLine ?? ""
    }`,
    `verifiedPositionBlockerStatus: ${
      capitalTradeAutoCycleClosure.verifiedPositionBlockerStatus ?? ""
    }`,
    `verifiedPositionFreshnessStatus: ${
      capitalTradeAutoCycleClosure.verifiedPositionFreshnessStatus ?? ""
    }`,
    `verifiedPositionBlockerMachineLine: ${
      capitalTradeAutoCycleClosure.verifiedPositionBlockerMachineLine ?? ""
    }`,
    `freshPaperCandidateCollectorStatus: ${
      capitalTradeAutoCycleClosure.freshPaperCandidateCollectorStatus ?? ""
    }`,
    `freshPaperCandidateCount: ${capitalTradeAutoCycleClosure.freshPaperCandidateCount ?? ""}`,
    `failedReplayQuoteDigestGateStatus: ${
      capitalTradeAutoCycleClosure.failedReplayQuoteDigestGateStatus ?? ""
    }`,
    `failedReplayQuoteDigestActiveSymbols: ${
      capitalTradeAutoCycleClosure.failedReplayQuoteDigestActiveSymbols?.join("|") || "none"
    }`,
    `failedReplayQuoteDigestUnlockedSymbols: ${
      capitalTradeAutoCycleClosure.failedReplayQuoteDigestUnlockedSymbols?.join("|") || "none"
    }`,
    `freshCandidateSameCaseRerunStatus: ${
      capitalTradeAutoCycleClosure.freshCandidateSameCaseRerunStatus ?? ""
    }`,
    `freshCandidateSameCaseRerunP05Pts: ${
      capitalTradeAutoCycleClosure.freshCandidateSameCaseRerunP05Pts ?? ""
    }`,
    `oppositeExposurePaperRerunStatus: ${
      capitalTradeAutoCycleClosure.oppositeExposurePaperRerunStatus ?? ""
    }`,
    `oppositeExposurePaperRerunP05Pts: ${
      capitalTradeAutoCycleClosure.oppositeExposurePaperRerunP05Pts ?? ""
    }`,
    `evaluatorRecommendation: ${capitalTradeAutoCycleClosure.evaluatorRecommendation ?? ""}`,
    `operatorCanExecute: ${renderFlag(capitalTradeAutoCycleClosure.operatorCanExecute)}`,
    `canTradeInsideOpenClaw: ${renderFlag(capitalTradeAutoCycleClosure.canTradeInsideOpenClaw)}`,
    `noLiveOrderSent: ${renderFlag(capitalTradeAutoCycleClosure.noLiveOrderSent)}`,
    `noOrderWrite: ${renderFlag(capitalTradeAutoCycleClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalTradeAutoCycleClosure.sentOrder)}`,
    "",
    "## Capital Tail-Risk Repair Closure",
    "",
    `machineLine: ${capitalTailRiskRepairClosure.machineLine ?? ""}`,
    `failedReplayHistoryMachineLine: ${
      capitalTailRiskRepairClosure.failedReplayHistoryMachineLine ?? ""
    }`,
    `reportRead: ${renderFlag(capitalTailRiskRepairClosure.reportRead)}`,
    `repairStatus: ${capitalTailRiskRepairClosure.repairStatus ?? ""}`,
    `planStatus: ${capitalTailRiskRepairClosure.planStatus ?? ""}`,
    `bucketCount: ${capitalTailRiskRepairClosure.bucketCount ?? 0}`,
    `bucketIds: ${
      Array.isArray(capitalTailRiskRepairClosure.bucketIds)
        ? capitalTailRiskRepairClosure.bucketIds.join(" / ")
        : ""
    }`,
    `nextBatchStatus: ${capitalTailRiskRepairClosure.nextBatchStatus ?? ""}`,
    `nextBatchSymbols: ${
      Array.isArray(capitalTailRiskRepairClosure.nextBatchSymbols)
        ? capitalTailRiskRepairClosure.nextBatchSymbols.join(" / ")
        : ""
    }`,
    `sameCaseRerunStatus: ${capitalTailRiskRepairClosure.sameCaseRerunStatus ?? ""}`,
    `sameCaseRanking: ${capitalTailRiskRepairClosure.sameCaseRankingLine ?? ""}`,
    `sameCaseReplayOutcome: ${capitalTailRiskRepairClosure.sameCaseReplayOutcomeStatus ?? ""}`,
    `sameCaseReplayP05: ${capitalTailRiskRepairClosure.sameCaseReplayP05Pts ?? ""}`,
    `sameCaseReplayP05Notional: ${capitalTailRiskRepairClosure.sameCaseReplayP05Notional ?? ""}`,
    `nextCommandMachineLine: ${capitalTailRiskRepairClosure.nextCommandMachineLine ?? ""}`,
    `nextCommand: ${capitalTailRiskRepairClosure.nextCommand ?? ""}`,
    `riskReview: ${capitalTailRiskRepairClosure.riskReviewStatus ?? ""}`,
    `sameCaseFollowUp: ${capitalTailRiskRepairClosure.sameCaseFollowUpCommand ?? ""}`,
    `sameCaseNoOrderWrite: ${renderFlag(capitalTailRiskRepairClosure.sameCaseNoOrderWrite)}`,
    `noOrderWrite: ${renderFlag(capitalTailRiskRepairClosure.noOrderWrite)}`,
    "",
    "## Capital Risk-Resized Rejection Closure",
    "",
    `machineLine: ${capitalRiskResizedRejectionClosure.machineLine ?? ""}`,
    `publishMachineLine: ${capitalRiskResizedRejectionClosure.publishMachineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalRiskResizedRejectionClosure.reportRead)}`,
    `status: ${capitalRiskResizedRejectionClosure.status ?? ""}`,
    `summaryStatus: ${capitalRiskResizedRejectionClosure.summaryStatus ?? ""}`,
    `rejectedCount: ${capitalRiskResizedRejectionClosure.rejectedCount ?? 0}`,
    `passCount: ${capitalRiskResizedRejectionClosure.passCount ?? 0}`,
    `blockedCount: ${capitalRiskResizedRejectionClosure.blockedCount ?? 0}`,
    `rejectedSymbols: ${
      Array.isArray(capitalRiskResizedRejectionClosure.rejectedSymbols)
        ? capitalRiskResizedRejectionClosure.rejectedSymbols.join(" / ")
        : ""
    }`,
    `p05Pts: ${capitalRiskResizedRejectionClosure.p05PtsLine ?? ""}`,
    `p05Notional: ${capitalRiskResizedRejectionClosure.p05NotionalLine ?? ""}`,
    `reasons: ${capitalRiskResizedRejectionClosure.reasonLine ?? ""}`,
    `passConditions: ${capitalRiskResizedRejectionClosure.passConditionsLine ?? ""}`,
    `nextCommand: ${capitalRiskResizedRejectionClosure.nextCommand ?? ""}`,
    `noOrderWrite: ${renderFlag(capitalRiskResizedRejectionClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalRiskResizedRejectionClosure.sentOrder)}`,
    "",
    "## Capital High-Confidence Paper Rerun Closure",
    "",
    `machineLine: ${capitalHighConfidencePaperRerunClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalHighConfidencePaperRerunClosure.reportRead)}`,
    `gateStatus: ${capitalHighConfidencePaperRerunClosure.gateStatus ?? ""}`,
    `threshold: ${capitalHighConfidencePaperRerunClosure.threshold ?? ""}`,
    `requiredConfidence: ${capitalHighConfidencePaperRerunClosure.requiredConfidence ?? ""}`,
    `requiredConfidenceStatus: ${capitalHighConfidencePaperRerunClosure.requiredConfidenceStatus ?? ""}`,
    `candidateSymbols: ${
      Array.isArray(capitalHighConfidencePaperRerunClosure.candidateSymbols)
        ? capitalHighConfidencePaperRerunClosure.candidateSymbols.join(" / ")
        : ""
    }`,
    `passCount: ${capitalHighConfidencePaperRerunClosure.passCount ?? 0}`,
    `blockedCount: ${capitalHighConfidencePaperRerunClosure.blockedCount ?? 0}`,
    `noOrderWrite: ${renderFlag(capitalHighConfidencePaperRerunClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalHighConfidencePaperRerunClosure.sentOrder)}`,
    "",
    "## Capital Verified Position Snapshot Closure",
    "",
    `machineLine: ${capitalVerifiedPositionSnapshotClosure.machineLine ?? ""}`,
    `reportRead: ${renderFlag(capitalVerifiedPositionSnapshotClosure.reportRead)}`,
    `status: ${capitalVerifiedPositionSnapshotClosure.status ?? ""}`,
    `decisionStatus: ${capitalVerifiedPositionSnapshotClosure.decisionStatus ?? ""}`,
    `freshnessStatus: ${capitalVerifiedPositionSnapshotClosure.freshnessStatus ?? ""}`,
    `verifiedAgeSeconds: ${capitalVerifiedPositionSnapshotClosure.verifiedAgeSeconds ?? 0}`,
    `maxFreshSeconds: ${capitalVerifiedPositionSnapshotClosure.maxFreshSeconds ?? 0}`,
    `hasOpenPosition: ${renderFlag(capitalVerifiedPositionSnapshotClosure.hasOpenPosition)}`,
    `netContracts: ${capitalVerifiedPositionSnapshotClosure.netContracts ?? 0}`,
    `nextCommand: ${capitalVerifiedPositionSnapshotClosure.nextCommand ?? ""}`,
    `noOrderWrite: ${renderFlag(capitalVerifiedPositionSnapshotClosure.noOrderWrite)}`,
    `sentOrder: ${renderFlag(capitalVerifiedPositionSnapshotClosure.sentOrder)}`,
    "",
    "## Assistant Closure",
    "",
    `callback: ${assistantClosure.callback}`,
    `statusStripVisible: ${renderFlag(assistantClosure.statusStripVisible)}`,
    `statusStripFixtureCoverage: ${statusStripFixtureCoverage.status ?? fixtureCoverage.status} ${statusStripFixtureCoverageTargets}`.trim(),
    `statusStripFixtureVisible: ${renderFlag(statusStripFixtureCoverage.visibleInAssistantStatusStrip)}`,
    `quickLinksVisible: ${renderFlag(assistantClosure.quickLinksVisible)}`,
    `quickLinksMatchPassedChecks: ${renderFlag(assistantClosure.quickLinksMatchPassedChecks)}`,
    `paperOnlySafetyVisible: ${renderFlag(assistantClosure.paperOnlySafetyVisible)}`,
    `paperLoopLearningRefresh.callback: ${paperLoopLearningRefresh.callback ?? ""}`,
    `paperLoopLearningRefresh.visibleInPaperLoop: ${renderFlag(
      paperLoopLearningRefresh.visibleInPaperLoop,
    )}`,
    `paperLoopLearningRefresh.visibleInAssistant: ${renderFlag(
      paperLoopLearningRefresh.visibleInAssistant,
    )}`,
    `paperLoopLearningRefresh.visibleInShortcutGate: ${renderFlag(
      paperLoopLearningRefresh.visibleInShortcutGate,
    )}`,
    `paperLoopLearningRefresh.commandHintVisible: ${renderFlag(
      paperLoopLearningRefresh.commandHintVisible,
    )}`,
    `paperLoopLearningRefresh.brokerCommandLocked: ${renderFlag(
      paperLoopLearningRefresh.brokerCommandLocked,
    )}`,
    `assistantLearningHint.callback: ${assistantLearningHint.callback ?? ""}`,
    `assistantLearningHint.commandHintVisible: ${renderFlag(
      assistantLearningHint.commandHintVisible,
    )}`,
    `assistantLearningHint.visibleInTradingHome: ${renderFlag(
      assistantLearningHint.visibleInTradingHome,
    )}`,
    `assistantLearningHint.verifiedVisibleInAssistant: ${renderFlag(
      assistantLearningHint.verifiedVisibleInAssistant,
    )}`,
    `assistantLearningHint.verifiedVisibleInLearningSummary: ${renderFlag(
      assistantLearningHint.verifiedVisibleInLearningSummary,
    )}`,
    `assistantLearningHint.quickLinksVisible: ${renderFlag(
      assistantLearningHint.quickLinksVisible,
    )}`,
    `assistantLearningHint.quickLinksMatchPassedChecks: ${renderFlag(
      assistantLearningHint.quickLinksMatchPassedChecks,
    )}`,
    `assistantLearningHint.verified: ${(
      assistantLearningHint.quickLinksVerifiedByChecks ?? []
    ).join(" / ")}`,
    `assistantLearningHint.brokerCommandLocked: ${renderFlag(
      assistantLearningHint.brokerCommandLocked,
    )}`,
    `assistantLearningHint.nextSafeCommand: ${assistantLearningHint.nextSafeCommand ?? ""}`,
    `assistantLearningHint.nextCommandShortRow.command: ${
      assistantNextCommandShortRow.command ?? ""
    }`,
    `assistantLearningHint.nextCommandShortRow.gateVerified: ${renderFlag(
      assistantNextCommandShortRow.gateVerified,
    )}`,
    `assistantLearningHint.nextCommandShortRow.machineLine: ${
      assistantNextCommandShortRow.machineLine ?? ""
    }`,
    "",
    "## Learning Summary Closure",
    "",
    `callback: ${learningSummaryClosure.callback ?? ""}`,
    `commandHintVisible: ${renderFlag(learningSummaryClosure.commandHintVisible)}`,
    `quickLinksVisible: ${renderFlag(learningSummaryClosure.quickLinksVisible)}`,
    `brokerCommandLocked: ${renderFlag(learningSummaryClosure.brokerCommandLocked)}`,
    "",
    "## Quick Links",
    "",
    renderList(assistantClosure.quickLinks),
    "",
    "## Verified By Checks",
    "",
    renderList(assistantClosure.quickLinksVerifiedByChecks),
    "",
    "## Assistant Entrypoints",
    "",
    renderList(report.summary.assistantStateEntrypoints),
    "",
    "## Evidence",
    "",
    "- reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    "- reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json.sha256",
    "",
    "## Safety",
    "",
    "- paper-only report surface",
    "- no broker submission",
    "- no live order enabled",
    "",
  ].join("\n");
}

function main() {
  const tradingCopy = readText(files.tradingCopy);
  const tradingPanel = readText(files.tradingPanel);
  const callbackRouter = readText(files.callbackRouter);
  const callbackRouterTest = readText(files.callbackRouterTest);
  const tradingPanelTest = readText(files.tradingPanelTest);
  const tradingGateway = readText(files.tradingGateway);
  const controlledRunnerScript = readText(files.controlledRunnerScript);
  const autonomousInventoryScript = readText(files.autonomousInventoryScript);
  const checkerScript = readText(files.checkerScript);
  const pkg = JSON.parse(readText(files.packageJson));
  const assistantState = readJsonOptional(files.assistantState);
  const okxCurrentReadinessSummaryReport = readJsonOptional(files.okxCurrentReadinessSummaryReport);
  const okxCurrentReadinessHeartbeatOperationReport = readJsonOptional(
    files.okxCurrentReadinessHeartbeatOperationReport,
  );
  const okxCurrentReadinessRefreshWorkflowReport = readJsonOptional(
    files.okxCurrentReadinessRefreshWorkflowReport,
  );
  const controlledRunnerTelegramPublishReport = readJsonOptional(
    files.controlledRunnerTelegramPublishReport,
  );
  const capitalOperatorPacketReport = readJsonOptional(files.capitalOperatorPacketReport);
  const capitalLocalExecutorDispatchReport = readJsonOptional(
    files.capitalLocalExecutorDispatchReport,
  );
  const capitalLiveExecutorArmProfileReport = readJsonOptional(
    files.capitalLiveExecutorArmProfileReport,
  );
  const capitalStrategyPlatformReport = readJsonOptional(files.capitalStrategyPlatformReport);
  const capitalTailRiskRepairReport = readJsonOptional(files.capitalTailRiskRepairReport);
  const capitalRiskResizedPaperRerunReport = readJsonOptional(
    files.capitalRiskResizedPaperRerunReport,
  );
  const capitalHighConfidencePaperRerunReport = readJsonOptional(
    files.capitalHighConfidencePaperRerunReport,
  );
  const capitalTradeAutoCycleReport = readJsonOptional(files.capitalTradeAutoCycleReport);
  const entrypoints = Array.isArray(assistantState?.assistant?.entrypoints)
    ? assistantState.assistant.entrypoints
    : [];
  const scripts = pkg.scripts ?? {};
  const checks = [];

  for (const shortcut of shortcuts) {
    addCheck(
      checks,
      `${shortcut.id}:copy-key`,
      tradingCopy.includes(`${shortcut.copyKey}:`) && tradingCopy.includes(shortcut.label),
      { copyKey: shortcut.copyKey, label: shortcut.label },
    );
    addCheck(
      checks,
      `${shortcut.id}:panel-button`,
      tradingPanel.includes(`TRADING_BUTTON_COPY.${shortcut.copyKey}`) &&
        tradingPanel.includes(`value: "${shortcut.callback}"`),
      { callback: shortcut.callback },
    );
    addCheck(
      checks,
      `${shortcut.id}:callback-size`,
      Buffer.byteLength(shortcut.callback, "utf8") <= 64,
      { bytes: Buffer.byteLength(shortcut.callback, "utf8") },
    );
    addCheck(
      checks,
      `${shortcut.id}:router-case`,
      callbackRouter.includes(shortcut.callbackCase) && callbackRouter.includes(shortcut.callback),
      { callbackCase: shortcut.callbackCase },
    );
    for (const command of shortcut.commands) {
      addCheck(
        checks,
        `${shortcut.id}:router-command:${command}`,
        callbackRouter.includes(command),
        { command },
      );
      addCheck(checks, `${shortcut.id}:command-target:${command}`, commandFileExists(command), {
        command,
      });
    }
    for (const method of shortcut.gatewayMethods ?? []) {
      addCheck(
        checks,
        `${shortcut.id}:gateway-method:${method}`,
        callbackRouter.includes(`"${method}"`),
        { method },
      );
    }
    for (const scriptName of shortcut.packageScripts ?? []) {
      addCheck(
        checks,
        `${shortcut.id}:package-script:${scriptName}`,
        typeof scripts[scriptName] === "string",
        { scriptName, command: scripts[scriptName] ?? "" },
      );
    }
    for (const entrypoint of shortcut.stateEntrypoints ?? []) {
      addCheck(
        checks,
        `${shortcut.id}:state-entrypoint:${entrypoint}`,
        entrypoints.includes(entrypoint),
        { entrypoint },
      );
    }
  }

  addCheck(checks, "safety:live-button-is-blocker-only", callbackRouter.includes("不得送出真單"), {
    callback: "sc:tr:live",
  });
  addCheck(
    checks,
    "safety:receipt-button-is-read-only-check",
    callbackRouter.includes('case "receipt"') &&
      callbackRouter.includes("不得執行 auto-deactivate execute") &&
      callbackRouter.includes("messageTokenCounts.receiptPrompt") &&
      callbackRouter.includes("receiptVerified") &&
      callbackRouter.includes("不得送出真單"),
    {
      callback: "sc:tr:receipt",
    },
  );
  addCheck(
    checks,
    "safety:dispatcher-reports-no-live-order",
    callbackRouter.includes("no_live_order_sent"),
    {
      callback: "sc:tr:disp",
    },
  );
  addCheck(
    checks,
    "capital-operator-packet:router-reads-report",
    callbackRouter.includes("openclaw-capital-live-operator-execution-packet-latest.json") &&
      callbackRouter.includes("operatorPacketReport") &&
      callbackRouter.includes("openclaw-capital-direct-strategy-platform-gate-latest.json") &&
      callbackRouter.includes("strategyPlatformReport"),
    { callback: "sc:tr:direct" },
  );
  addCheck(
    checks,
    "capital-operator-packet:direct-panel-visible",
    tradingPanel.includes("Operator Execution Packet") &&
      tradingPanel.includes("operatorCanExecute") &&
      tradingPanel.includes("dispatchPolicy") &&
      tradingPanel.includes("operatorPacketReport") &&
      tradingPanel.includes("strategyPlatformReport") &&
      tradingPanel.includes("liveExecutorArmProfileReport") &&
      tradingPanel.includes("autoDeactivateReceiptGateReport") &&
      tradingPanel.includes("adapterAckApplyVerifierReport") &&
      tradingPanel.includes("adapterAckApplyPlanReport") &&
      tradingPanel.includes("adapterAckApplyReceiptReport") &&
      tradingPanel.includes("postApplyClosureReport") &&
      tradingPanel.includes("真單解鎖三件事") &&
      tradingPanel.includes("回關收據 Gate") &&
      tradingPanel.includes("Adapter Post-Apply Readback") &&
      tradingPanel.includes("adapterPostApplyReadbackText") &&
      tradingPanel.includes("pendingExplicitExecuteReceipt") &&
      tradingPanel.includes("receiptVerified") &&
      tradingPanel.includes("heartbeatExecuteAllowed") &&
      tradingPanel.includes("verified position snapshot") &&
      tradingPanel.includes("adapter ack required-current") &&
      tradingPanel.includes("live executor arm profile") &&
      tradingPanel.includes("allowExecutorWrite") &&
      tradingPanel.includes("armProfile=<code>") &&
      tradingPanel.includes("liveCompletion") &&
      tradingPanel.includes("noOrderWrite") &&
      tradingPanel.includes("freshnessStatus") &&
      tradingPanel.includes("verifiedAgeSeconds") &&
      tradingPanel.includes("requiredCurrent") &&
      tradingPanel.includes("externalBrokerAdapterAckRequiredCurrent") &&
      tradingPanel.includes("expectedSealedIntentSha256") &&
      tradingPanel.includes("actualSealedIntentSha256") &&
      tradingPanel.includes("hashOk") &&
      tradingPanel.includes("canaryPass") &&
      tradingPanel.includes("canarySentOrder") &&
      tradingPanel.includes("rollbackPass") &&
      tradingPanel.includes("rollbackFreshnessStatus") &&
      tradingPanel.includes("rollbackAgeSeconds") &&
      tradingPanel.includes("liveCompletionStages") &&
      callbackRouter.includes("openclaw-capital-live-executor-arm-profile-latest.json") &&
      callbackRouter.includes("openclaw-capital-adapter-ack-operator-apply-verifier-latest.json") &&
      callbackRouter.includes("openclaw-capital-adapter-ack-operator-apply-plan-latest.json") &&
      callbackRouter.includes(
        "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
      ) &&
      callbackRouter.includes("openclaw-capital-post-apply-live-closure-gate-latest.json") &&
      tradingPanelTest.includes("真單解鎖三件事") &&
      tradingPanelTest.includes("回關收據 Gate") &&
      tradingPanelTest.includes("Adapter Post-Apply Readback") &&
      tradingPanelTest.includes("receiptVerified=❌") &&
      callbackRouterTest.includes(
        "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
      ) &&
      callbackRouterTest.includes("Adapter Post-Apply Readback") &&
      callbackRouterTest.includes("pendingExplicitExecuteReceipt=✅") &&
      tradingPanelTest.includes("live executor arm profile=❌") &&
      callbackRouterTest.includes("capital-live-executor-arm-profile.json"),
    { callback: "sc:tr:direct" },
  );
  addCheck(
    checks,
    "capital-tail-risk-repair:direct-panel-visible",
    tradingPanel.includes("策略 Tail-Risk 修復") &&
      tradingPanel.includes("strategyTailRiskRepair") &&
      tradingPanel.includes("repairCandidatePlan") &&
      tradingPanel.includes("repairCandidateBuckets") &&
      tradingPanel.includes("sameCaseRerunEvidence") &&
      tradingPanel.includes("sameCaseRerunRankingLine") &&
      tradingPanel.includes("tailRiskRepairBucketText") &&
      tradingPanel.includes("candidatePlan=") &&
      tradingPanelTest.includes("策略 Tail-Risk 修復") &&
      tradingPanelTest.includes("candidatePlan=<code>needs_candidate_or_outcome_evidence</code>") &&
      tradingPanelTest.includes("rerunEvidence=<code>ready_for_same_case_rerun</code>") &&
      tradingPanelTest.includes("ranked=<code>1:YM0000:-40|2:NQ0000:-80|3:MCL0000:-400</code>") &&
      tradingPanelTest.includes("fresh_resolved_low_correlation_or_opposite_exposure") &&
      tradingPanelTest.includes("contract_point_value_currency_backfill") &&
      tradingPanelTest.includes("noOrderWrite=✅"),
    { callback: "sc:tr:direct" },
  );
  addCheck(
    checks,
    "capital-operator-packet:directrun-command",
    callbackRouter.includes("pnpm capital:trade:operator-packet") &&
      callbackRouter.includes("pnpm capital:trade:operator-packet:check") &&
      callbackRouter.includes("pnpm capital:trade:platform") &&
      callbackRouter.includes("pnpm capital:trade:platform:check") &&
      typeof scripts["capital:trade:operator-packet"] === "string" &&
      typeof scripts["capital:trade:operator-packet:check"] === "string" &&
      typeof scripts["capital:trade:platform"] === "string" &&
      typeof scripts["capital:trade:platform:check"] === "string",
    { callback: "sc:tr:directrun" },
  );
  addCheck(
    checks,
    "capital-position-snapshot:directpos-readback-command",
    callbackRouter.includes('case "directpos"') &&
      callbackRouter.includes("只重讀 operator-owned verified position snapshot") &&
      callbackRouter.includes("不得建立或覆寫 active position snapshot") &&
      callbackRouter.includes("pnpm capital:trade:direct:status:check") &&
      callbackRouter.includes("pnpm capital:trade:platform:check") &&
      callbackRouter.includes("pnpm capital-hft:telegram-trading-shortcuts:check") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.directPositionRefresh") &&
      tradingPanel.includes('value: "sc:tr:directpos"') &&
      tradingPanelTest.includes("sc:tr:directpos"),
    { callback: "sc:tr:directpos", noOrderWrite: true },
  );
  addCheck(
    checks,
    "capital-position-snapshot:direct-panel-operator-refresh-visible",
    tradingPanel.includes("operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos") &&
      tradingPanel.includes("pnpm capital:trade:direct:status:check") &&
      tradingPanel.includes("noOrderWrite=${boolBadge(") &&
      tradingPanelTest.includes(
        "operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos",
      ) &&
      callbackRouterTest.includes(
        "operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos",
      ),
    {
      callback: "sc:tr:direct",
      followUp: "sc:tr:directpos",
      noOrderWrite: true,
    },
  );
  addCheck(
    checks,
    "ai-platform:panel-builder",
    tradingPanel.includes("buildAiTradingPlatformPanel") &&
      tradingPanel.includes("fastOrderTicket") &&
      tradingPanel.includes("券商閘門") &&
      tradingPanel.includes("快速進出場票"),
    { callback: "sc:tr:platform" },
  );
  addCheck(
    checks,
    "ai-platform:gateway-snapshot-read",
    callbackRouter.includes("fetchTradingPlatformSnapshot") &&
      callbackRouter.includes('callGatewayCompat<unknown>(api, "trading.snapshot")'),
    { method: "trading.snapshot" },
  );
  addCheck(
    checks,
    "ai-platform:live-order-remains-gated",
    tradingPanel.includes("brokerCommandEnabled") &&
      tradingPanel.includes("submissionCommand") &&
      tradingPanel.includes("liveOrderAllowed") &&
      tradingPanel.includes("executionAllowed"),
    { callback: "sc:tr:platform" },
  );
  addCheck(
    checks,
    "ai-platform:okx-lifecycle-snapshot",
    tradingGateway.includes("okxLifecycle") &&
      tradingGateway.includes("summarizeOkxLifecycle") &&
      tradingGateway.includes("openclaw-okx-order-status-gate-latest.json") &&
      tradingGateway.includes("demoSimulation") &&
      tradingGateway.includes("exchangeWriteAttempted") &&
      tradingGateway.includes("cancelSubmitted"),
    { method: "trading.snapshot" },
  );
  addCheck(
    checks,
    "ai-platform:okx-lifecycle-visible",
    tradingPanel.includes("OKX 生命週期") &&
      tradingPanel.includes("simulationCode") &&
      tradingPanel.includes("simulationStatus") &&
      tradingPanel.includes("exchangeWriteAttempted") &&
      tradingPanel.includes("cancelSubmitted"),
    { callback: "sc:tr:platform" },
  );
  addCheck(
    checks,
    "ai-platform:okx-paper-audit-summary-snapshot",
    tradingGateway.includes("okxPaperAuditSummary") &&
      tradingGateway.includes("summarizeOkxPaperAuditSummary") &&
      tradingGateway.includes("openclaw-okx-paper-audit-summary-latest.json") &&
      tradingGateway.includes("safetyAggregate") &&
      tradingGateway.includes("orderStatusQueryExecutedCount"),
    { method: "trading.snapshot" },
  );
  addCheck(
    checks,
    "ai-platform:okx-paper-audit-summary-visible",
    (tradingPanel.includes("OKX Paper Audit") || tradingPanel.includes("OKX 模擬稽核")) &&
      tradingPanel.includes("okxPaperAuditSummary") &&
      tradingPanel.includes("allEntriesSafe") &&
      tradingPanel.includes("submittedOrderCount") &&
      tradingPanel.includes("orderStatusQueryExecutedCount") &&
      tradingPanel.includes("openclaw-okx-paper-audit-summary-latest.json"),
    { callback: "sc:tr:platform" },
  );
  addCheck(
    checks,
    "okx-order-status:demo-simulation-visible",
    (tradingPanel.includes("Demo 模擬生命週期") || tradingPanel.includes("模擬生命週期")) &&
      tradingPanel.includes("demoSimulation") &&
      tradingPanel.includes("simulatedClientOrderId") &&
      tradingPanel.includes("exchangeWriteAttempted") &&
      tradingPanel.includes("cancelSubmitted"),
    { callback: "sc:tr:okxstat" },
  );
  addCheck(
    checks,
    "okx-order-status:router-reads-report",
    callbackRouter.includes("fetchOkxOrderStatusGateState") &&
      callbackRouter.includes("buildOkxOrderStatusPanel(orderStatusState)") &&
      callbackRouter.includes("openclaw-okx-order-status-gate-latest.json"),
    { callback: "sc:tr:okxstat" },
  );
  addCheck(
    checks,
    "okx-order-status:paper-audit-summary-read",
    callbackRouter.includes("fetchOkxOrderStatusGateState") &&
      callbackRouter.includes("paperAuditSummary") &&
      callbackRouter.includes("openclaw-okx-paper-audit-summary-latest.json"),
    { callback: "sc:tr:okxstat" },
  );
  addCheck(
    checks,
    "okx-order-status:paper-audit-summary-visible",
    tradingPanel.includes("state.paperAuditSummary") &&
      (tradingPanel.includes("Paper Audit") || tradingPanel.includes("模擬稽核")) &&
      tradingPanel.includes("allEntriesSafe") &&
      tradingPanel.includes("orderStatusQueryExecuted") &&
      tradingPanel.includes("openclaw-okx-paper-audit-summary-latest.json"),
    { callback: "sc:tr:okxstat" },
  );
  addCheck(
    checks,
    "fast-ticket-write:panel-button",
    tradingPanel.includes("TRADING_BUTTON_COPY.writeFastTicket") &&
      tradingPanel.includes('value: "sc:tr:write"') &&
      tradingPanel.includes("buildFastOrderIntentWritePanel"),
    { callback: "sc:tr:write" },
  );
  addCheck(
    checks,
    "fast-ticket-write:router-gateway-method",
    callbackRouter.includes('case "write"') &&
      callbackRouter.includes('"trading.fastOrderIntent.write"') &&
      callbackRouter.includes("writeTradingFastOrderIntent"),
    { method: "trading.fastOrderIntent.write" },
  );
  addCheck(
    checks,
    "fast-ticket-write:state-report-paths",
    tradingGateway.includes("telegram-fast-order-intents.jsonl") &&
      tradingGateway.includes("openclaw-telegram-fast-order-intent-latest.json"),
    { callback: "sc:tr:write" },
  );
  addCheck(
    checks,
    "fast-ticket-write:no-broker-submission",
    tradingPanel.includes("sentBrokerOrder") &&
      tradingGateway.includes("sentBrokerOrder: false") &&
      tradingGateway.includes("brokerCommandEnabled: false") &&
      tradingGateway.includes('submissionCommand: ""'),
    { callback: "sc:tr:write" },
  );
  addCheck(
    checks,
    "fast-ticket-review:panel-buttons",
    tradingPanel.includes("TRADING_BUTTON_COPY.approvePaper") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.denyFastTicket") &&
      tradingPanel.includes('value: "sc:tr:approve"') &&
      tradingPanel.includes('value: "sc:tr:deny"') &&
      tradingPanel.includes("buildFastOrderIntentReviewPanel"),
    { callbacks: ["sc:tr:approve", "sc:tr:deny"] },
  );
  addCheck(
    checks,
    "fast-ticket-review:router-gateway-methods",
    callbackRouter.includes('case "approve"') &&
      callbackRouter.includes('case "deny"') &&
      callbackRouter.includes('"trading.fastOrderIntent.approvePaper"') &&
      callbackRouter.includes('"trading.fastOrderIntent.deny"'),
    { callbacks: ["sc:tr:approve", "sc:tr:deny"] },
  );
  addCheck(
    checks,
    "fast-ticket-review:paper-execution-audit-paths",
    tradingGateway.includes("telegram-fast-order-review-decisions.jsonl") &&
      tradingGateway.includes("telegram-fast-order-paper-executions.jsonl") &&
      tradingGateway.includes("openclaw-telegram-fast-order-review-latest.json") &&
      tradingGateway.includes("openclaw-telegram-fast-order-paper-execution-latest.json"),
    { method: "trading.fastOrderIntent.approvePaper" },
  );
  addCheck(
    checks,
    "fast-ticket-review:no-broker-submission",
    tradingGateway.includes("reviewTradingFastOrderIntent") &&
      tradingGateway.includes("sentBrokerOrder: false") &&
      tradingGateway.includes("brokerCommandEnabled: false") &&
      tradingGateway.includes('submissionCommand: ""') &&
      tradingPanel.includes("paperOnly"),
    { callbacks: ["sc:tr:approve", "sc:tr:deny"] },
  );
  addCheck(
    checks,
    "fast-ticket-audit:panel-button",
    tradingPanel.includes("TRADING_BUTTON_COPY.auditTrail") &&
      tradingPanel.includes('value: "sc:tr:audit"') &&
      tradingPanel.includes("buildFastOrderAuditTrailPanel"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:router-gateway-method",
    callbackRouter.includes('case "audit"') &&
      callbackRouter.includes('"trading.fastOrderAudit.snapshot"') &&
      callbackRouter.includes("fetchTradingFastOrderAuditSnapshot"),
    { method: "trading.fastOrderAudit.snapshot" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:read-source-paths",
    tradingGateway.includes("readTradingFastOrderAuditSnapshot") &&
      tradingGateway.includes("openclaw-telegram-fast-order-intent-latest.json") &&
      tradingGateway.includes("openclaw-telegram-fast-order-review-latest.json") &&
      tradingGateway.includes("openclaw-telegram-fast-order-paper-execution-latest.json"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:no-broker-submission",
    tradingPanel.includes("快速進出場審核紀錄") &&
      tradingPanel.includes("sentBrokerOrder") &&
      tradingPanel.includes("brokerCommandEnabled") &&
      tradingPanel.includes("submissionCommand") &&
      tradingGateway.includes("sentBrokerOrder: false"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:history-jsonl-reader",
    tradingGateway.includes("readTradingFastOrderAuditHistory") &&
      tradingGateway.includes("readLatestJsonLines") &&
      tradingGateway.includes("FAST_ORDER_AUDIT_FILTERS"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:telegram-filter-pagination",
    tradingPanel.includes("最近審核 / 模擬歷史") &&
      tradingPanel.includes("sc:tr:audit:paper_0") &&
      tradingPanel.includes("sc:tr:audit:denied_0") &&
      tradingPanel.includes("上一頁") &&
      tradingPanel.includes("下一頁"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-summary",
    tradingPanel.includes("auditSummary") &&
      tradingPanel.includes("快速進出場審核摘要") &&
      tradingPanel.includes("學習模式") &&
      tradingPanel.includes("buildTradingPanelAuditSummary") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.auditTrail"),
    { callback: "sc:trade" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-review-loop",
    tradingPanel.includes("TRADING_BUTTON_COPY.writeFastTicket") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.paperReviewLoop") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.tradeAutoCycle") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.approvePaper") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.denyFastTicket") &&
      tradingPanel.includes('value: "sc:tr:write"') &&
      tradingPanel.includes('value: "sc:tr:paperloop"') &&
      tradingPanel.includes('value: "sc:tr:auto"') &&
      tradingPanel.includes('value: "sc:tr:approve"') &&
      tradingPanel.includes('value: "sc:tr:deny"'),
    {
      callbacks: ["sc:tr:paperloop", "sc:tr:auto", "sc:tr:write", "sc:tr:approve", "sc:tr:deny"],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:paper-loop-copy",
    tradingCopy.includes("paperReviewLoop") && tradingCopy.includes("一鍵模擬閉環"),
    { callback: "sc:tr:paperloop" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:paper-loop-panel-button",
    tradingPanel.includes("TRADING_BUTTON_COPY.paperReviewLoop") &&
      tradingPanel.includes('value: "sc:tr:paperloop"') &&
      tradingPanel.includes("buildFastOrderAuditTrailPanel"),
    { callback: "sc:tr:paperloop" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:paper-loop-router-chain",
    callbackRouter.includes('case "paperloop"') &&
      callbackRouter.includes("writeTradingFastOrderIntent(api)") &&
      callbackRouter.includes('reviewTradingFastOrderIntent(api, "approve_paper")') &&
      callbackRouter.includes("refreshTradingFastOrderLearningSnapshot(api)") &&
      callbackRouter.includes('"trading.fastOrderLearningSnapshot.refresh"') &&
      callbackRouter.includes("fetchTradingFastOrderAuditSnapshot(api, {") &&
      callbackRouter.includes("limit: 5"),
    { callback: "sc:tr:paperloop" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:paper-loop-learning-refresh-visible",
    callbackRouter.includes("learningSnapshotRefresh") &&
      callbackRouter.includes("refreshTradingFastOrderLearningSnapshot(api)") &&
      tradingPanel.includes("學習快照") &&
      tradingPanel.includes("assistantFastOrderPaperPattern") &&
      tradingPanel.includes("snapshotPath"),
    { callback: "sc:tr:paperloop" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:platform-learning-pattern",
    tradingPanel.includes("快速進出場學習") &&
      tradingPanel.includes("platformPaperPattern") &&
      tradingPanel.includes("fastOrderPaperPattern") &&
      tradingPanel.includes("buildPaperExecutionLearningPattern(") &&
      callbackRouter.includes('case "platform"') &&
      callbackRouter.includes("buildAiTradingPlatformPanel(snapshot, auditSummary)") &&
      callbackRouter.includes("fetchTradingFastOrderAuditSnapshot(api,") &&
      callbackRouter.includes("limit: 5"),
    { callback: "sc:tr:platform" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:gateway-assistant-pattern-read",
    tradingGateway.includes("readAssistantFastOrderPaperPattern") &&
      tradingGateway.includes(".openclaw/ui/auto-trading-assistant-state.json") &&
      tradingGateway.includes(".openclaw/ui/capital-paper-assistant-state.json") &&
      tradingGateway.includes("fastOrderPaperPattern"),
    {
      stateFiles: [
        ".openclaw/ui/auto-trading-assistant-state.json",
        ".openclaw/ui/capital-paper-assistant-state.json",
      ],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:audit-snapshot-exposes-pattern",
    tradingGateway.includes("TradingFastOrderPaperPatternSnapshot") &&
      tradingGateway.includes("fastOrderPaperPattern,") &&
      tradingGateway.includes("readAssistantFastOrderPaperPattern(repoRoot)") &&
      tradingPanel.includes("buildPaperExecutionLearningPattern(state)"),
    { method: "trading.fastOrderAudit.snapshot" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-panel-pattern",
    tradingPanel.includes("buildCapitalPaperAssistantPanel") &&
      tradingPanel.includes("fastOrderPaperPattern") &&
      tradingPanel.includes("快速進出場模擬模式") &&
      tradingPanel.includes("brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)"),
    { callback: "sc:tr:assist" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-panel-watch-refresh",
    callbackRouter.includes("telegramPaperLoopLearningRefresh") &&
      callbackRouter.includes("auto-trading-watch-state.json") &&
      tradingPanel.includes("Telegram 模擬閉環") &&
      tradingPanel.includes("telegramPaperLoopLearningRefresh") &&
      tradingPanel.includes("assistantFastOrderPaperPattern") &&
      tradingPanel.includes("snapshotPath"),
    { callback: "sc:tr:assist", stateFile: ".openclaw/ui/auto-trading-watch-state.json" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-panel-status-shortcuts",
    tradingPanel.includes("TRADING_BUTTON_COPY.learningSummary") &&
      tradingPanel.includes('value: "sc:tr:learn"') &&
      tradingPanel.includes("TRADING_BUTTON_COPY.auditTrail") &&
      tradingPanel.includes('value: "sc:tr:audit"') &&
      tradingPanel.includes("TRADING_BUTTON_COPY.paperReviewLoop") &&
      tradingPanel.includes('value: "sc:tr:paperloop"') &&
      callbackRouter.includes('case "learn"') &&
      callbackRouter.includes('case "audit"') &&
      callbackRouter.includes('case "paperloop"'),
    {
      callback: "sc:tr:assist",
      quickLinks: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop"],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-panel-status-strip",
    tradingPanel.includes("快速狀態") &&
      tradingPanel.includes("statusStripText") &&
      tradingPanel.includes("learning?.status") &&
      tradingPanel.includes("fastOrderPaperPattern?.latestStatus") &&
      tradingPanel.includes("telegramPaperLoopLearningRefresh?.status ?? loop?.status") &&
      tradingPanel.includes("fixtureCoverageText") &&
      tradingPanel.includes("fixtureCoverage?.targets") &&
      tradingPanelTest.includes(
        "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ) &&
      callbackRouterTest.includes(
        "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ),
    { callback: "sc:tr:assist" },
  );
  addCheck(
    checks,
    "okx-paper-audit:assistant-status-strip-machine-line",
    tradingPanel.includes("okxPaperAuditClosure") &&
      tradingPanel.includes("okxPaperAuditClosure=<code>") &&
      tradingPanel.includes("machineLine") &&
      tradingPanelTest.includes("noOrderWrite=true") &&
      tradingPanelTest.includes("okxPaperAuditClosure=<code>okxPaperAudit=pass") &&
      callbackRouter.includes("fetchTelegramTradingShortcutsSummaryState()") &&
      callbackRouter.includes("buildCapitalPaperAssistantPanel(assistantPanelState)"),
    {
      callback: "sc:tr:assist",
      summaryKey: "okxPaperAuditClosure.machineLine",
    },
  );
  const assistantClosureQuickLinks = ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop"];
  const paperLoopLearningRefreshSummary = {
    callback: "sc:tr:paperloop",
    gatewayMethod: "trading.fastOrderLearningSnapshot.refresh",
    visibleInPaperLoop:
      callbackRouter.includes("learningSnapshotRefresh") &&
      callbackRouter.includes("refreshTradingFastOrderLearningSnapshot(api)") &&
      tradingPanel.includes("學習快照") &&
      tradingPanel.includes("assistantFastOrderPaperPattern") &&
      tradingPanel.includes("snapshotPath"),
    visibleInAssistant:
      callbackRouter.includes("telegramPaperLoopLearningRefresh") &&
      callbackRouter.includes("auto-trading-watch-state.json") &&
      tradingPanel.includes("Telegram 模擬閉環") &&
      tradingPanel.includes("telegramPaperLoopLearningRefresh") &&
      tradingPanel.includes("assistantFastOrderPaperPattern") &&
      tradingPanel.includes("snapshotPath"),
    visibleInShortcutGate:
      tradingPanel.includes("buildTelegramShortcutGateSummary") &&
      tradingPanel.includes("paperLoopLearningRefresh") &&
      tradingPanel.includes("paperLoop=") &&
      tradingPanel.includes("brokerLocked="),
    commandHintVisible:
      tradingPanel.includes("buildTelegramPaperLoopCommandHint") &&
      tradingPanel.includes("nextSafeCommand=<code>") &&
      tradingPanel.includes("commandHint=") &&
      tradingPanel.includes("新的 fresh quote 後才重跑 sc:tr:paperloop") &&
      tradingPanel.includes("sc:tr:learn / sc:tr:audit") &&
      tradingPanel.includes("buildAssistantLearningSummaryCommandHint") &&
      tradingPanel.includes(
        "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanel.includes("回模擬助手確認安全鎖"),
    brokerCommandLocked: tradingPanel.includes(
      "brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)",
    ),
  };
  const assistantLearningHintSummary = {
    callback: "sc:tr:assist",
    source: "buildAssistantLearningSummaryCommandHint",
    nextSafeCommand: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
    nextCommandShortRow: {
      command: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
      gateVerified: true,
      buttons: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
      machineLine:
        "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
    },
    quickLinks: ["sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
    commandHint: "先看審核紀錄；新的 fresh quote 後才重跑 sc:tr:paperloop；回模擬助手確認安全鎖。",
    commandHintVisible:
      tradingPanel.includes("buildAssistantLearningSummaryCommandHint") &&
      tradingPanel.includes(
        "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanel.includes("回模擬助手確認安全鎖"),
    visibleInTradingHome:
      tradingPanel.includes("buildTelegramShortcutGateSummary") &&
      tradingPanel.includes("assistantLearningHint") &&
      tradingPanel.includes('formatAssistantLearningHint(assistantLearningHint, "compact")') &&
      tradingPanel.includes("learningHint=<code>") &&
      tradingPanel.includes("assistantLearningHint.brokerCommandLocked"),
    verifiedVisibleInAssistant:
      tradingPanel.includes("formatAssistantLearningHint") &&
      tradingPanel.includes("assistantLearningHintVerifiedText") &&
      tradingPanel.includes(
        'formatAssistantLearningHint(getAssistantLearningHintFromShortcutGate(state), "verified")',
      ) &&
      tradingPanel.includes("gateVerified=") &&
      tradingPanel.includes("quickLinksVerifiedByChecks") &&
      tradingPanel.includes("quickLinksMatchPassedChecks") &&
      tradingPanel.includes("下一步指令已由 gate 驗證"),
    verifiedVisibleInLearningSummary:
      tradingPanel.includes("shortcutGateSummary?: TelegramTradingShortcutsSummaryState") &&
      tradingPanel.includes("buildAssistantLearningHintVerifiedText(shortcutGateSummary)") &&
      callbackRouter.includes(
        "const [summary, auditSummary, shortcutGateSummary] = await Promise.all",
      ) &&
      callbackRouter.includes("fetchTelegramTradingShortcutsSummaryState()") &&
      callbackRouter.includes(
        "buildLearningSummaryPanel(summary, auditSummary, shortcutGateSummary)",
      ),
    quickLinksVisible:
      tradingPanel.includes('value: "sc:tr:audit"') &&
      tradingPanel.includes('value: "sc:tr:paperloop"') &&
      tradingPanel.includes('value: "sc:tr:assist"'),
    brokerCommandLocked: tradingPanel.includes(
      "brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)",
    ),
  };
  const assistantClosureSummary = {
    callback: "sc:tr:assist",
    statusStripVisible:
      tradingPanel.includes("快速狀態") &&
      tradingPanel.includes("statusStripText") &&
      tradingPanel.includes("telegramPaperLoopLearningRefresh?.status ?? loop?.status"),
    quickLinks: assistantClosureQuickLinks,
    quickLinksVisible:
      tradingPanel.includes('value: "sc:tr:learn"') &&
      tradingPanel.includes('value: "sc:tr:audit"') &&
      tradingPanel.includes('value: "sc:tr:paperloop"'),
    paperOnlySafetyVisible: tradingPanel.includes(
      "brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)",
    ),
    paperLoopLearningRefresh: paperLoopLearningRefreshSummary,
    assistantLearningHint: assistantLearningHintSummary,
  };
  const learningSummaryClosure = {
    callback: "sc:tr:learn",
    quickLinks: ["sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
    commandHintVisible:
      tradingPanel.includes("buildLearningSummaryCommandHint") &&
      tradingPanel.includes(
        "nextSafeCommand=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanel.includes("新的 fresh quote 後才重跑 sc:tr:paperloop") &&
      tradingPanel.includes("回模擬助手確認安全鎖"),
    quickLinksVisible:
      tradingPanel.includes('value: "sc:tr:audit"') &&
      tradingPanel.includes('value: "sc:tr:paperloop"') &&
      tradingPanel.includes('value: "sc:tr:assist"'),
    brokerCommandLocked: tradingPanel.includes(
      "brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)",
    ),
  };
  addCheck(
    checks,
    "fast-ticket-audit:assistant-report-summary",
    assistantClosureSummary.statusStripVisible &&
      assistantClosureSummary.quickLinksVisible &&
      assistantClosureSummary.paperOnlySafetyVisible,
    { callback: "sc:tr:assist", summaryKey: "assistantClosure" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-report-status-strip-fixture-coverage",
    assistantClosureSummary.statusStripVisible &&
      checkerScript.includes("statusStripFixtureCoverage") &&
      checkerScript.includes("statusStripFixtureVisible") &&
      checkerScript.includes("visibleInAssistantStatusStrip") &&
      checkerScript.includes("statusStripFixtureCoverage: ${") &&
      tradingPanel.includes("fixture=<code>") &&
      tradingPanelTest.includes(
        "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ) &&
      callbackRouterTest.includes(
        "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ),
    {
      callback: "sc:tr:assist",
      summaryKey: "assistantClosure.statusStripFixtureCoverage",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-status-strip-check-count-closure",
    assistantClosureSummary.statusStripVisible &&
      checkerScript.includes("shortcutCheckCountClosure") &&
      checkerScript.includes("checkCountMachineLine") &&
      tradingPanel.includes("shortcutCheckCountClosure") &&
      tradingPanel.includes("checkCountClosure=<code>") &&
      tradingPanel.includes("checkCount=<code>") &&
      tradingPanelTest.includes("shortcutChecks=192 failed=0 assistantClosure=42") &&
      tradingPanelTest.includes("okxClosure=18") &&
      tradingPanelTest.includes("fixtureCoverage=4") &&
      tradingPanelTest.includes("reportMachine=12") &&
      tradingPanelTest.includes("growthReason=assistant+okx+fixture+report-machine"),
    {
      callback: "sc:tr:assist",
      summaryKey: "shortcutCheckCountClosure.machineLine",
      target: "assistant-status-strip",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-report-paperloop-refresh-sync",
    assistantClosureSummary.paperLoopLearningRefresh.visibleInPaperLoop &&
      assistantClosureSummary.paperLoopLearningRefresh.visibleInAssistant &&
      assistantClosureSummary.paperLoopLearningRefresh.visibleInShortcutGate &&
      assistantClosureSummary.paperLoopLearningRefresh.commandHintVisible &&
      assistantClosureSummary.paperLoopLearningRefresh.brokerCommandLocked,
    { callback: "sc:tr:paperloop", summaryKey: "assistantClosure.paperLoopLearningRefresh" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-paperloop-command-hint",
    assistantClosureSummary.paperLoopLearningRefresh.commandHintVisible,
    { callback: "sc:tr:assist", target: "sc:tr:learn/sc:tr:audit" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-learning-hint-structured-report",
    assistantClosureSummary.assistantLearningHint.commandHintVisible &&
      assistantClosureSummary.assistantLearningHint.quickLinksVisible &&
      assistantClosureSummary.assistantLearningHint.brokerCommandLocked &&
      assistantClosureSummary.assistantLearningHint.nextSafeCommand ===
        "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
    { callback: "sc:tr:assist", summaryKey: "assistantClosure.assistantLearningHint" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-next-command-short-row",
    tradingPanel.includes("function buildAssistantNextCommandShortRow(") &&
      tradingPanel.includes("function getAssistantNextCommandShortRow(") &&
      tradingPanel.includes("function readAssistantNextCommand(") &&
      tradingPanel.includes("nextCommandShortRow=<code>") &&
      tradingPanel.includes("buttons=<code>${buttonText}</code>") &&
      tradingPanel.includes("nextCommandShortRow?.command") &&
      tradingPanel.includes("nextCommandShortRow?.gateVerified") &&
      tradingPanel.includes("stringList(nextCommandShortRow?.buttons)") &&
      tradingPanel.includes("buildAssistantNextCommandShortRow(") &&
      tradingPanelTest.includes(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanelTest.includes("gateVerified=✅ buttons=<code>sc:tr:learn"),
    {
      callback: "sc:tr:assist",
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow",
      target: "assistant-panel",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-next-command-short-row-json-contract",
    assistantClosureSummary.assistantLearningHint.nextCommandShortRow.command ===
      assistantClosureSummary.assistantLearningHint.nextSafeCommand &&
      assistantClosureSummary.assistantLearningHint.nextCommandShortRow.gateVerified &&
      Array.isArray(assistantClosureSummary.assistantLearningHint.nextCommandShortRow.buttons) &&
      assistantClosureSummary.assistantLearningHint.nextCommandShortRow.buttons.includes(
        "sc:tr:learn",
      ) &&
      assistantClosureSummary.assistantLearningHint.nextCommandShortRow.machineLine.includes(
        "gateVerified=true",
      ),
    {
      callback: "sc:tr:assist",
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow",
      target: "report-json",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:learning-summary-next-command-short-row",
    tradingPanel.includes("const nextCommandShortRow = buildAssistantNextCommandShortRow") &&
      tradingPanel.includes("${commandHintText}${nextCommandShortRow}${gateVerifiedText}") &&
      tradingPanelTest.includes(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanelTest.includes("gateVerified=✅ buttons=<code>sc:tr:learn") &&
      callbackRouter.includes(
        "buildLearningSummaryPanel(summary, auditSummary, shortcutGateSummary)",
      ),
    {
      callback: "sc:tr:learn",
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow",
      target: "learning-summary",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-next-command-short-row",
    tradingPanel.includes(
      "const shortcutNextCommandShortRow = buildAssistantNextCommandShortRow(state)",
    ) &&
      tradingPanel.includes("shortcutNextCommandShortRow +") &&
      tradingPanelTest.includes(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      tradingPanelTest.includes("gateVerified=✅ buttons=<code>sc:tr:learn"),
    {
      callback: "sc:trade",
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow",
      target: "trading-home",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-assistant-learning-hint",
    assistantClosureSummary.assistantLearningHint.visibleInTradingHome,
    {
      callback: "sc:trade",
      summaryKey: "assistantClosure.assistantLearningHint",
      target: "trading-home",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:learning-summary-pattern",
    tradingPanel.includes("快速進出場模擬模式") &&
      tradingPanel.includes("buildPaperExecutionLearningPattern(auditSummary)") &&
      tradingPanel.includes("TRADING_BUTTON_COPY.paperReviewLoop") &&
      callbackRouter.includes('case "learn"') &&
      callbackRouter.includes(
        "buildLearningSummaryPanel(summary, auditSummary, shortcutGateSummary)",
      ) &&
      callbackRouter.includes("fetchTradingFastOrderAuditSnapshot(api,") &&
      callbackRouter.includes("fetchTelegramTradingShortcutsSummaryState()") &&
      callbackRouter.includes("limit: 5"),
    { callback: "sc:tr:learn" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:learning-summary-command-hint",
    learningSummaryClosure.commandHintVisible &&
      learningSummaryClosure.quickLinksVisible &&
      learningSummaryClosure.brokerCommandLocked,
    { callback: "sc:tr:learn", summaryKey: "learningSummaryClosure" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-fetch",
    callbackRouter.includes("fetchTradingFastOrderAuditSnapshot(api, {") &&
      callbackRouter.includes('filter: "all"') &&
      callbackRouter.includes("limit: 3") &&
      callbackRouter.includes("auditSummary"),
    { method: "trading.fastOrderAudit.snapshot" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-shortcut-gate-summary",
    tradingPanel.includes("shortcutGateSummary") &&
      tradingPanel.includes("buildTelegramShortcutGateSummary") &&
      tradingPanel.includes("Telegram 快捷 Gate") &&
      tradingPanel.includes("fixtureCoverage=<code>") &&
      tradingPanel.includes("fixtureCoverage?.targets") &&
      tradingPanelTest.includes(
        "fixtureCoverage=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ) &&
      callbackRouterTest.includes(
        "fixtureCoverage=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      ) &&
      callbackRouter.includes("fetchTelegramTradingShortcutsSummaryState") &&
      callbackRouter.includes("openclaw-telegram-trading-shortcuts-latest.json") &&
      callbackRouter.includes("shortcutGateSummary"),
    {
      callback: "sc:trade",
      stateFile: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-panel-shortcut-gate-strip",
    tradingPanel.includes("shortcutGateSummary?: TelegramTradingShortcutsSummaryState") &&
      tradingPanel.includes("formatShortcutGateStatusStrip") &&
      tradingPanel.includes("快捷=<code>") &&
      callbackRouter.includes("const [assistantState, shortcutGateSummary] = await Promise.all") &&
      callbackRouter.includes("fetchTelegramTradingShortcutsSummaryState()") &&
      callbackRouter.includes("assistantPanelState") &&
      callbackRouter.includes("buildCapitalPaperAssistantPanel(assistantPanelState)"),
    {
      callback: "sc:tr:assist",
      stateFile: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:okx-status-read",
    callbackRouter.includes("openclaw-okx-current-readiness-summary-latest.json") &&
      callbackRouter.includes("currentReadinessSummary"),
    {
      callback: "sc:tr:okx",
      report: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:okx-status-visible",
    (tradingPanel.includes("OKX Current Readiness") || tradingPanel.includes("OKX 當前就緒摘要")) &&
      tradingPanel.includes("currentReadinessSummary") &&
      tradingPanel.includes("currentReadinessRefreshWorkflow") &&
      tradingPanel.includes("openclaw-okx-current-readiness-refresh-workflow-latest.json") &&
      (tradingPanel.includes("machineLine=<code>") || tradingPanel.includes("機器摘要=<code>")) &&
      (tradingPanel.includes("noOrderWrite=") || tradingPanel.includes("禁止下單寫入=")) &&
      tradingPanel.includes("openclaw-okx-current-readiness-summary-latest.json"),
    {
      callback: "sc:tr:okx",
      report: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:scheduler-evidence-visible",
    tradingPanelTest.includes("okxCurrentReadiness=ready quote=ok scheduler=pass") &&
      tradingPanelTest.includes("schedulerNextRunAt=") &&
      tradingPanelTest.includes("okxCurrentReadinessRefresh=pass steps=7/7") &&
      tradingPanelTest.includes("failedSteps=<code>無</code>") &&
      tradingPanelTest.includes("latestRefreshRun=<code>skipped_not_needed/null</code>") &&
      callbackRouter.includes("openclaw-okx-current-readiness-refresh-workflow-latest.json") &&
      callbackRouter.includes("currentReadinessRefreshWorkflow") &&
      tradingPanelTest.includes("openclaw-okx-current-readiness-summary-latest.json"),
    {
      callback: "sc:tr:okx",
      report: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
      target: "trading-panel.test.ts",
    },
  );
  addCheck(
    checks,
    "okx-market-snapshot-scheduler:okx-status-read",
    callbackRouter.includes("openclaw-okx-market-snapshot-scheduler-latest.json") &&
      callbackRouter.includes("marketSnapshotScheduler"),
    {
      callback: "sc:tr:okx",
      report: "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
    },
  );
  addCheck(
    checks,
    "okx-market-snapshot-scheduler:okx-status-visible",
    tradingPanel.includes("OKX 報價排程") &&
      tradingPanel.includes("marketSnapshotScheduler") &&
      (tradingPanel.includes("nextRunAt") || tradingPanel.includes("下次=<code>")) &&
      tradingPanel.includes("marketSnapshotScheduler.machineLine") &&
      tradingPanel.includes("pnpm okx:market-snapshot:scheduler:check") &&
      tradingPanel.includes("openclaw-okx-market-snapshot-scheduler-latest.json") &&
      (tradingPanel.includes("noOrderWrite=") || tradingPanel.includes("禁止下單寫入=")),
    {
      callback: "sc:tr:okx",
      report: "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
      command: "pnpm okx:market-snapshot:scheduler:check",
    },
  );
  addCheck(
    checks,
    "okx-market-snapshot-scheduler:test-visible",
    tradingPanelTest.includes("okxMarketSnapshotScheduler=pass") &&
      tradingPanelTest.includes("nextRunAt=2026-05-24T19:42:52.788Z") &&
      tradingPanelTest.includes("2026-05-24T19:42:52.788Z") &&
      tradingPanelTest.includes("openclaw-okx-market-snapshot-scheduler-latest.json") &&
      tradingPanelTest.includes("禁止下單寫入=✅") &&
      tradingPanelTest.includes("pnpm okx:market-snapshot:scheduler:check"),
    {
      callback: "sc:tr:okx",
      target: "trading-panel.test.ts",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:refresh-entry-visible",
    tradingPanel.includes("TRADING_BUTTON_COPY.okxReadinessRefresh") &&
      tradingPanel.includes('value: "sc:tr:okxrefresh"') &&
      tradingPanel.includes("pnpm okx:current-readiness:refresh"),
    {
      callback: "sc:tr:okxrefresh",
      command: "pnpm okx:current-readiness:refresh",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:refresh-router-ready",
    callbackRouter.includes('case "okxrefresh"') &&
      callbackRouter.includes("pnpm okx:current-readiness:refresh") &&
      callbackRouter.includes("pnpm okx:current-readiness:refresh:check") &&
      callbackRouter.includes("noOrderWrite=true") &&
      callbackRouter.includes("不得查私有訂單") &&
      callbackRouter.includes("不得送單") &&
      callbackRouter.includes("不得取消") &&
      callbackRouter.includes("不得啟用 live"),
    {
      callback: "sc:tr:okxrefresh",
      command: "pnpm okx:current-readiness:refresh",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:assistant-summary-read",
    checkerScript.includes("buildOkxCurrentReadinessClosure") &&
      checkerScript.includes("okxCurrentReadinessClosure"),
    {
      callback: "sc:tr:assist",
      summaryKey: "okxCurrentReadinessClosure",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness:assistant-status-strip-visible",
    tradingPanel.includes("okxCurrentReadinessClosure") &&
      tradingPanel.includes("okxCurrentReadinessClosure=<code>") &&
      tradingPanelTest.includes("okxCurrentReadiness=ready") &&
      tradingPanelTest.includes("okxCurrentReadinessClosure=<code>"),
    {
      callback: "sc:tr:assist",
      summaryKey: "okxCurrentReadinessClosure.machineLine",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:report-read",
    callbackRouter.includes("openclaw-okx-current-readiness-heartbeat-operation-latest.json") &&
      callbackRouter.includes("openclaw-okx-current-readiness-refresh-workflow-latest.json") &&
      callbackRouter.includes("buildOkxCurrentReadinessHeartbeatOperationClosure") &&
      callbackRouter.includes("buildOkxCurrentReadinessRefreshWorkflowClosure") &&
      checkerScript.includes("okxCurrentReadinessHeartbeatOperationReport") &&
      checkerScript.includes("okxCurrentReadinessRefreshWorkflowReport") &&
      checkerScript.includes("buildOkxCurrentReadinessHeartbeatOperationClosure") &&
      checkerScript.includes("buildOkxCurrentReadinessRefreshWorkflowClosure"),
    {
      callback: "sc:tr:assist",
      report:
        "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
      summaryKey: "okxCurrentReadinessHeartbeatOperationClosure",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:assistant-status-strip-visible",
    tradingPanel.includes("okxCurrentReadinessHeartbeatOperationClosure") &&
      tradingPanel.includes("okxCurrentReadinessRefreshWorkflowClosure") &&
      tradingPanel.includes("okxRefreshWorkflow=<code>") &&
      tradingPanel.includes("okxRefreshSteps=<code>") &&
      tradingPanel.includes("okxCurrentReadinessHeartbeatOperationClosure=<code>") &&
      tradingPanel.includes("okxHeartbeatNext=<code>") &&
      tradingPanel.includes("okxHeartbeatRefresh=<code>") &&
      tradingPanel.includes("okxHeartbeatSchedulerNextRunAt=<code>") &&
      callbackRouter.includes("openclaw-okx-current-readiness-refresh-workflow-latest.json") &&
      callbackRouter.includes("buildOkxCurrentReadinessRefreshWorkflowClosure") &&
      callbackRouter.includes("okxCurrentReadinessRefreshWorkflowClosure") &&
      tradingPanelTest.includes("okxCurrentReadinessRefresh=pass steps=7/7") &&
      tradingPanelTest.includes("okxCurrentReadinessRefresh=fail steps=5/7") &&
      tradingPanelTest.includes("failedSteps=telegram_shortcuts / current_readiness_summary") &&
      tradingPanelTest.includes("okxRefreshWorkflow=<code>") &&
      tradingPanelTest.includes("okxRefreshSteps=<code>7/7</code>") &&
      tradingPanelTest.includes("okxCurrentReadinessHeartbeat=idle") &&
      tradingPanelTest.includes("okxCurrentReadinessHeartbeat=refresh_available") &&
      tradingPanelTest.includes("okxCurrentReadinessHeartbeatOperationClosure=<code>") &&
      tradingPanelTest.includes("okxHeartbeatNext=<code>") &&
      tradingPanelTest.includes("okxHeartbeatRefresh=<code>sc:tr:okxrefresh") &&
      tradingPanelTest.includes(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      ) &&
      tradingPanelTest.includes("executeRequired=✅ noOrderWrite=✅") &&
      callbackRouterTest.includes("writeOkxHeartbeatOperationReportFixture") &&
      callbackRouterTest.includes("writeOkxRefreshWorkflowReportFixture") &&
      callbackRouterTest.includes("okxRefreshWorkflow=<code>") &&
      callbackRouterTest.includes("okxRefreshSteps=<code>7/7</code>") &&
      callbackRouterTest.includes("okxRefreshSteps=<code>5/7</code>") &&
      callbackRouterTest.includes("current_readiness_summary latestRefreshRun=<code>fail/1") &&
      callbackRouterTest.includes("okxCurrentReadinessHeartbeatOperationClosure=<code>") &&
      callbackRouterTest.includes("okxHeartbeatNext=<code>") &&
      callbackRouterTest.includes("okxHeartbeatRefresh=<code>sc:tr:okxrefresh") &&
      callbackRouterTest.includes(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      ),
    {
      callback: "sc:tr:assist",
      summaryKey: "okxCurrentReadinessHeartbeatOperationClosure.machineLine",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:commands-visible",
    scripts["okx:current-readiness:heartbeat"] &&
      scripts["okx:current-readiness:heartbeat:check"] &&
      scripts["okx:current-readiness:heartbeat:execute"] &&
      callbackRouter.includes("oneClickRefresh") &&
      callbackRouter.includes("executeCommand") &&
      callbackRouter.includes("nextSafeTask") &&
      callbackRouter.includes("inventoryProbeMachineLine") &&
      callbackRouter.includes("buildOkxHeartbeatOperationReplyContextHtml") &&
      callbackRouter.includes("operationContextHtml") &&
      callbackRouter.includes("okxHeartbeatInventory=<code>") &&
      callbackRouter.includes("okxHeartbeatSchedulerNextRunAt=<code>") &&
      callbackRouterTest.includes(
        "pushes OKX refresh completion with heartbeat next-action context",
      ) &&
      callbackRouterTest.includes("pushes OKX refresh_available heartbeat next-action context") &&
      callbackRouterTest.includes("OKX heartbeat next-action") &&
      callbackRouterTest.includes("refresh_available_read_only") &&
      callbackRouterTest.includes("okxHeartbeatRefresh=<code>sc:tr:okxrefresh") &&
      callbackRouterTest.includes("executeRequired=✅ noOrderWrite=✅") &&
      callbackRouterTest.includes("okxHeartbeatInventory=<code>ready / okxInventoryProbe=pass") &&
      checkerScript.includes("okx:current-readiness:heartbeat") &&
      checkerScript.includes("okx:current-readiness:refresh") &&
      checkerScript.includes("oneClickRefresh") &&
      tradingPanelTest.includes("noOrderWrite=true"),
    {
      callback: "sc:tr:assist",
      command: "pnpm okx:current-readiness:heartbeat",
      noOrderWrite: true,
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:router-query-params",
    callbackRouter.includes("parseFastOrderAuditQuery") &&
      callbackRouter.includes('"trading.fastOrderAudit.snapshot", query') &&
      callbackRouter.includes("filter") &&
      callbackRouter.includes("offset"),
    { method: "trading.fastOrderAudit.snapshot" },
  );
  addCheck(
    checks,
    "fast-ticket-audit:paper-history-correlates-intent",
    tradingGateway.includes("intentId: intent.intentId") &&
      tradingGateway.includes('status: "paper_execution_recorded"') &&
      tradingGateway.includes("FAST_ORDER_PAPER_EXECUTIONS_JSONL"),
    { callback: "sc:tr:audit" },
  );
  addCheck(
    checks,
    "chart-strategy:strategy-panel-renders-state",
    tradingPanel.includes("圖表策略") &&
      tradingPanel.includes("chartStrategyStatus") &&
      tradingPanel.includes("enabledStrategyCount"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "chart-strategy:router-reads-assistant-state",
    callbackRouter.includes("readLatestAssistantStateForStrategy") &&
      callbackRouter.includes("parseStrategyStateFromAssistant") &&
      callbackRouter.includes("chartStrategy"),
    { stateFile: ".openclaw/ui/auto-trading-assistant-state.json" },
  );
  addCheck(
    checks,
    "chart-strategy:live-order-remains-gated",
    tradingPanel.includes("實單允許") &&
      callbackRouter.includes("liveOrderAllowed") &&
      callbackRouter.includes("brokerOrderPathEnabled"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "chart-strategy:simulation-visible",
    tradingPanel.includes("simulationStatus") &&
      tradingPanel.includes("simulationWinRate") &&
      tradingPanel.includes("simulationPaperIntentCount"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "chart-strategy:fast-order-paper-pattern-visible",
    tradingPanel.includes("快速進出場模擬模式") &&
      tradingPanel.includes("buildPaperExecutionLearningPattern(auditSummary)") &&
      callbackRouter.includes('case "strat"') &&
      callbackRouter.includes("buildStrategyPanel(stratState, auditSummary)") &&
      callbackRouter.includes("fetchTradingFastOrderAuditSnapshot(api, {") &&
      callbackRouter.includes('filter: "all"') &&
      callbackRouter.includes("limit: 5"),
    { callback: "sc:tr:strat", method: "trading.fastOrderAudit.snapshot" },
  );
  addCheck(
    checks,
    "fill-simulation:strategy-panel-renders-state",
    tradingPanel.includes("成交模擬") &&
      tradingPanel.includes("fillSimulationStatus") &&
      tradingPanel.includes("expectedValuePts") &&
      tradingPanel.includes("monteCarloP05Pts"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "fill-simulation:router-reads-report",
    callbackRouter.includes("readStrategyFillSimulationState") &&
      callbackRouter.includes("parseStrategyFillSimulationState") &&
      callbackRouter.includes("capital-strategy-fill-simulation.json"),
    { stateFile: ".openclaw/trading/capital-strategy-fill-simulation.json" },
  );
  addCheck(
    checks,
    "fill-simulation:safety-visible",
    tradingPanel.includes("fillPromotionBlocked") &&
      callbackRouter.includes("promotionBlocked") &&
      callbackRouter.includes("executionEligible"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "blocker-snapshot:strategy-panel-renders-state",
    tradingPanel.includes("即時阻擋") &&
      tradingPanel.includes("quoteGateStatus") &&
      tradingPanel.includes("fullChainBlockers") &&
      tradingPanel.includes("livePromotionBlockerCode"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "blocker-snapshot:router-reads-quote-reports",
    callbackRouter.includes("parseStrategyBlockerSnapshot") &&
      callbackRouter.includes("capital-quote-status.json") &&
      callbackRouter.includes("capital-reportable-quote-state.json") &&
      callbackRouter.includes("capital-tick-diagnostic.json"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "blocker-snapshot:router-reads-learning-and-gates",
    callbackRouter.includes("capital-paper-learning-summary.json") &&
      callbackRouter.includes("openclaw-capital-full-chain-simulation-gate-latest.json") &&
      callbackRouter.includes("openclaw-capital-live-trading-promotion-gate-latest.json"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "blocker-snapshot:live-remains-review-only",
    tradingPanel.includes("readyForManualReview") &&
      callbackRouter.includes("readyForManualReview") &&
      callbackRouter.includes("livePromotionBlockers"),
    { callback: "sc:tr:strat" },
  );
  addCheck(
    checks,
    "fill-simulation:package-check-script",
    typeof scripts["capital:strategy:fill-simulation:check"] === "string",
    {
      scriptName: "capital:strategy:fill-simulation:check",
      command: scripts["capital:strategy:fill-simulation:check"] ?? "",
    },
  );
  addCheck(
    checks,
    "strategy-rerun:copy-key",
    tradingCopy.includes("rerunChecks:") && tradingCopy.includes("重跑檢查"),
    { callback: "sc:tr:rerun" },
  );
  addCheck(
    checks,
    "strategy-rerun:strategy-panel-button",
    tradingPanel.includes("TRADING_BUTTON_COPY.rerunChecks") &&
      tradingPanel.includes('value: "sc:tr:rerun"'),
    { callback: "sc:tr:rerun" },
  );
  addCheck(checks, "strategy-rerun:callback-size", Buffer.byteLength("sc:tr:rerun", "utf8") <= 64, {
    bytes: Buffer.byteLength("sc:tr:rerun", "utf8"),
  });
  addCheck(
    checks,
    "strategy-rerun:router-case",
    callbackRouter.includes('case "rerun"') && callbackRouter.includes("sc:tr:rerun"),
    { callback: "sc:tr:rerun" },
  );
  addCheck(
    checks,
    "strategy-rerun:router-commands",
    [
      "pnpm capital:strategy:fill-simulation",
      "pnpm capital:strategy:fill-simulation:check",
      "pnpm capital-hft:auto-trading",
      "pnpm capital-hft:auto-trading-assistant:check",
      "pnpm capital-hft:auto-trading-loop:check",
      "pnpm capital-hft:auto-trading:check",
    ].every((command) => callbackRouter.includes(command)),
    { callback: "sc:tr:rerun" },
  );
  addCheck(
    checks,
    "strategy-rerun:package-scripts",
    [
      "capital:strategy:fill-simulation",
      "capital:strategy:fill-simulation:check",
      "capital-hft:auto-trading",
      "capital-hft:auto-trading-assistant:check",
      "capital-hft:auto-trading-loop:check",
      "capital-hft:auto-trading:check",
    ].every((scriptName) => typeof scripts[scriptName] === "string"),
    { callback: "sc:tr:rerun" },
  );
  addCheck(
    checks,
    "strategy-rerun:safety-text",
    callbackRouter.includes("不得啟用 live") &&
      callbackRouter.includes("不得 approve") &&
      callbackRouter.includes("不得送出真單"),
    { callback: "sc:tr:rerun" },
  );
  addCheck(
    checks,
    "strategy-rerun:assistant-status-strip-sync",
    tradingPanel.includes("formatRerunStatusStrip") &&
      tradingPanel.includes("重跑=<code>") &&
      tradingPanel.includes("state.generatedAt") &&
      callbackRouter.includes("sc:tr:assist 快速狀態列") &&
      callbackRouter.includes('backAction: "sc:tr:assist"') &&
      callbackRouter.includes('backLabel: "← 模擬助手"'),
    { callback: "sc:tr:rerun", target: "sc:tr:assist" },
  );

  const expectedAssistantQuickLinks = assistantClosureSummary.quickLinks.toSorted((left, right) =>
    left.localeCompare(right),
  );
  const passedAssistantQuickLinks = [
    ...new Set(
      checks
        .filter(
          (check) =>
            check.status === "pass" && assistantClosureSummary.quickLinks.includes(check.callback),
        )
        .map((check) => check.callback),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  assistantClosureSummary.quickLinksVerifiedByChecks = passedAssistantQuickLinks;
  assistantClosureSummary.quickLinksMatchPassedChecks =
    expectedAssistantQuickLinks.length === passedAssistantQuickLinks.length &&
    expectedAssistantQuickLinks.every(
      (callback, index) => callback === passedAssistantQuickLinks[index],
    );
  const expectedAssistantLearningHintQuickLinks = [
    ...assistantClosureSummary.assistantLearningHint.quickLinks,
  ].toSorted((left, right) => left.localeCompare(right));
  const passedAssistantLearningHintQuickLinks = [
    ...new Set(
      checks
        .filter(
          (check) =>
            check.status === "pass" &&
            assistantClosureSummary.assistantLearningHint.quickLinks.includes(check.callback),
        )
        .map((check) => check.callback),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  const assistantLearningHintCommandLinks =
    assistantClosureSummary.assistantLearningHint.nextSafeCommand.split(" / ");
  assistantClosureSummary.assistantLearningHint.quickLinksVerifiedByChecks =
    passedAssistantLearningHintQuickLinks;
  assistantClosureSummary.assistantLearningHint.quickLinksMatchPassedChecks =
    expectedAssistantLearningHintQuickLinks.length ===
      passedAssistantLearningHintQuickLinks.length &&
    expectedAssistantLearningHintQuickLinks.every(
      (callback, index) => callback === passedAssistantLearningHintQuickLinks[index],
    ) &&
    assistantLearningHintCommandLinks.length ===
      assistantClosureSummary.assistantLearningHint.quickLinks.length &&
    assistantLearningHintCommandLinks.every(
      (callback, index) =>
        callback === assistantClosureSummary.assistantLearningHint.quickLinks[index],
    );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-report-summary-quicklinks-match",
    assistantClosureSummary.quickLinksMatchPassedChecks,
    {
      summaryKey: "assistantClosure.quickLinks",
      expected: expectedAssistantQuickLinks,
      actual: passedAssistantQuickLinks,
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:trading-home-learning-hint-verified-callbacks",
    assistantClosureSummary.assistantLearningHint.quickLinksMatchPassedChecks,
    {
      summaryKey: "assistantClosure.assistantLearningHint.quickLinks",
      expected: expectedAssistantLearningHintQuickLinks,
      actual: passedAssistantLearningHintQuickLinks,
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-learning-hint-verified-visible",
    assistantClosureSummary.assistantLearningHint.verifiedVisibleInAssistant &&
      assistantClosureSummary.assistantLearningHint.quickLinksMatchPassedChecks,
    {
      callback: "sc:tr:assist",
      summaryKey: "assistantClosure.assistantLearningHint",
      target: "assistant-panel",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:learning-summary-verified-hint-visible",
    assistantClosureSummary.assistantLearningHint.verifiedVisibleInLearningSummary &&
      assistantClosureSummary.assistantLearningHint.quickLinksMatchPassedChecks,
    {
      callback: "sc:tr:learn",
      summaryKey: "assistantClosure.assistantLearningHint",
      target: "learning-summary",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:assistant-learning-hint-shared-formatter",
    tradingPanel.includes("function formatAssistantLearningHint(") &&
      tradingPanel.includes('mode: "compact" | "verified"') &&
      tradingPanel.includes('formatAssistantLearningHint(assistantLearningHint, "compact")') &&
      tradingPanel.includes(
        'formatAssistantLearningHint(getAssistantLearningHintFromShortcutGate(state), "verified")',
      ) &&
      tradingPanel.includes("buildAssistantLearningHintVerifiedText(shortcutGateSummary)") &&
      tradingPanel.includes("const assistantLearningHintVerifiedText") &&
      tradingPanel.includes("state.shortcutGateSummary"),
    {
      summaryKey: "assistantClosure.assistantLearningHint",
      targets: ["sc:trade", "sc:tr:assist", "sc:tr:learn"],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:callback-learning-summary-shared-formatter-fixture",
    callbackRouter.includes(
      "buildLearningSummaryPanel(summary, auditSummary, shortcutGateSummary)",
    ) &&
      callbackRouterTest.includes("renders learning summary panel with fast order audit pattern") &&
      callbackRouterTest.includes("openclaw-telegram-trading-shortcuts-latest.json") &&
      callbackRouterTest.includes("function buildShortcutGateReportFixture(") &&
      callbackRouterTest.includes("writeShortcutGateReportFixture(repoRoot") &&
      callbackRouterTest.includes("assistantLearningHint") &&
      callbackRouterTest.includes(
        'quickLinksVerifiedByChecks: ["sc:tr:assist", "sc:tr:audit", "sc:tr:paperloop"]',
      ) &&
      callbackRouterTest.includes("quickLinksMatchPassedChecks: true") &&
      callbackRouterTest.includes("paperLoopLearningRefresh") &&
      callbackRouterTest.includes("brokerCommandLocked: true") &&
      tradingPanelTest.includes("function buildShortcutGateSummaryFixture(") &&
      tradingPanelTest.includes("TelegramTradingShortcutsSummaryState") &&
      tradingPanelTest.includes(
        'quickLinksVerifiedByChecks: ["sc:tr:assist", "sc:tr:audit", "sc:tr:paperloop"]',
      ) &&
      tradingPanelTest.includes("quickLinksMatchPassedChecks: true") &&
      tradingPanelTest.includes("paperLoopLearningRefresh") &&
      tradingPanelTest.includes("brokerCommandLocked: true") &&
      tradingPanelTest.includes("shortcutGateSummary: buildShortcutGateSummaryFixture") &&
      callbackRouterTest.includes("gateVerified=✅") &&
      callbackRouterTest.includes("verified=sc:tr:assist / sc:tr:audit / sc:tr:paperloop") &&
      callbackRouterTest.includes("下一步指令已由 gate 驗證"),
    {
      callback: "sc:tr:learn",
      summaryKey: "assistantClosure.assistantLearningHint",
      targets: ["callback-router.test.ts", "trading-panel.test.ts"],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:next-command-short-row-fixture-contract",
    tradingPanel.includes("function readAssistantNextCommand(") &&
      tradingPanel.includes("nextCommandShortRow?.command") &&
      tradingPanel.includes("nextCommandShortRow?.gateVerified") &&
      tradingPanel.includes("stringList(nextCommandShortRow?.buttons)") &&
      tradingPanelTest.includes("renders next-command short row from report fixture contract") &&
      tradingPanelTest.includes('assistantLearningHint.nextSafeCommand = "DRIFTED sc:tr:live"') &&
      tradingPanelTest.includes("assistantLearningHint.quickLinksMatchPassedChecks = false") &&
      tradingPanelTest.includes('expect(text).not.toContain("DRIFTED sc:tr:live")') &&
      checkerScript.includes("assistantLearningHint.nextCommandShortRow.command") &&
      checkerScript.includes("assistantLearningHint.nextCommandShortRow.machineLine"),
    {
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow.machineLine",
      targets: ["trading-panel.test.ts", "openclaw-telegram-trading-shortcuts-summary.md"],
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:callback-next-command-short-row-machine-line-fixture",
    callbackRouterTest.includes("nextCommandShortRow") &&
      callbackRouterTest.includes(
        "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
      ) &&
      callbackRouterTest.includes(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      ) &&
      callbackRouterTest.includes("openclaw-telegram-trading-shortcuts-latest.json"),
    {
      callback: "sc:tr:learn",
      summaryKey: "assistantClosure.assistantLearningHint.nextCommandShortRow.machineLine",
      target: "callback-router.test.ts",
    },
  );

  const okxPaperAuditClosure = buildOkxPaperAuditClosure(checks);
  addCheck(
    checks,
    "okx-paper-audit:telegram-report-machine-summary",
    okxPaperAuditClosure.status === "pass" &&
      okxPaperAuditClosure.machineLine.includes("platform=read+visible") &&
      okxPaperAuditClosure.machineLine.includes("okxstat=read+visible") &&
      okxPaperAuditClosure.machineLine.includes("noOrderWrite=true"),
    {
      summaryKey: "okxPaperAuditClosure.machineLine",
      machineLine: okxPaperAuditClosure.machineLine,
    },
  );
  const okxCurrentReadinessClosure = buildOkxCurrentReadinessClosure(checks);
  addCheck(
    checks,
    "okx-current-readiness:telegram-report-machine-summary",
    okxCurrentReadinessClosure.status === "ready" &&
      okxCurrentReadinessClosure.machineLine.includes("okx=read+visible") &&
      okxCurrentReadinessClosure.machineLine.includes("scheduler=read+visible") &&
      okxCurrentReadinessClosure.machineLine.includes("assist=read+visible") &&
      okxCurrentReadinessClosure.machineLine.includes("refresh=available") &&
      okxCurrentReadinessClosure.machineLine.includes("freshness=ok") &&
      okxCurrentReadinessClosure.machineLine.includes("noOrderWrite=true"),
    {
      summaryKey: "okxCurrentReadinessClosure.machineLine",
      machineLine: okxCurrentReadinessClosure.machineLine,
    },
  );
  const okxCurrentReadinessHeartbeatOperationClosure =
    buildOkxCurrentReadinessHeartbeatOperationClosure(
      checks,
      okxCurrentReadinessHeartbeatOperationReport,
    );
  const okxCurrentReadinessRefreshWorkflowClosure = buildOkxCurrentReadinessRefreshWorkflowClosure(
    checks,
    okxCurrentReadinessRefreshWorkflowReport,
    okxCurrentReadinessHeartbeatOperationReport,
  );
  const okxCurrentReadinessInventoryProbeClosure =
    buildOkxCurrentReadinessInventoryProbeClosure(autonomousInventoryScript);
  const okxHeartbeatPublishTokenCountClosure = buildOkxHeartbeatPublishTokenCountClosure(
    controlledRunnerTelegramPublishReport,
  );
  const okxSchedulerNoOrderContractProbeClosure = buildOkxSchedulerNoOrderContractProbeClosure({
    currentReadinessReport: okxCurrentReadinessSummaryReport,
    refreshWorkflowReport: okxCurrentReadinessRefreshWorkflowReport,
    heartbeatOperationReport: okxCurrentReadinessHeartbeatOperationReport,
  });
  const capitalOperatorPacketClosure = buildCapitalOperatorPacketClosure(
    capitalOperatorPacketReport,
  );
  const capitalLocalExecutorDispatchClosure = buildCapitalLocalExecutorDispatchClosure(
    capitalLocalExecutorDispatchReport,
  );
  const capitalLiveExecutorArmProfileClosure = buildCapitalLiveExecutorArmProfileClosure(
    capitalLiveExecutorArmProfileReport,
  );
  const capitalTailRiskRepairClosure = buildCapitalTailRiskRepairClosure(
    capitalStrategyPlatformReport,
    capitalTailRiskRepairReport,
  );
  const capitalRiskResizedRejectionClosure = buildCapitalRiskResizedRejectionClosure(
    capitalRiskResizedPaperRerunReport,
  );
  const capitalHighConfidencePaperRerunClosure = buildCapitalHighConfidencePaperRerunClosure(
    capitalHighConfidencePaperRerunReport,
  );
  const capitalTradeAutoCycleClosure = buildCapitalTradeAutoCycleClosure(
    capitalTradeAutoCycleReport,
  );
  const capitalVerifiedPositionSnapshotClosure = buildCapitalVerifiedPositionSnapshotClosure(
    capitalStrategyPlatformReport,
  );
  addCheck(
    checks,
    "okx-current-readiness:scheduler-no-order-contract-probe",
    okxSchedulerNoOrderContractProbeClosure.status === "ready" &&
      okxSchedulerNoOrderContractProbeClosure.machineLine.includes(
        "okxSchedulerNoOrderContract=pass",
      ) &&
      okxSchedulerNoOrderContractProbeClosure.machineLine.includes("reports=3/3") &&
      okxSchedulerNoOrderContractProbeClosure.machineLine.includes("schedulerNextRunAt=") &&
      okxSchedulerNoOrderContractProbeClosure.machineLine.includes("noOrderWrite=true"),
    {
      summaryKey: "okxSchedulerNoOrderContractProbeClosure.status",
      machineLine: okxSchedulerNoOrderContractProbeClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-operator-packet:telegram-report-machine-summary",
    capitalOperatorPacketClosure.reportRead === true &&
      capitalOperatorPacketClosure.machineLine.includes("capitalOperatorPacket=") &&
      capitalOperatorPacketClosure.machineLine.includes("adapterCanarySentOrder=false") &&
      capitalOperatorPacketClosure.machineLine.includes("adapterRollbackFresh=") &&
      capitalOperatorPacketClosure.machineLine.includes("adapterApplyReceipt=") &&
      capitalOperatorPacketClosure.noOrderWrite === true &&
      capitalOperatorPacketClosure.sentOrder === false &&
      // Legacy blocked stage: operatorCanExecute=false, receipt pending apply
      // Current ready stage: operatorCanExecute=true, receipt no_apply_required/verified
      ((capitalOperatorPacketClosure.machineLine.includes("operatorCanExecute=false") &&
        capitalOperatorPacketClosure.machineLine.includes("adapterApplyReceiptVerified=false") &&
        capitalOperatorPacketClosure.adapterApplyReceiptStatus === "pending_operator_apply" &&
        capitalOperatorPacketClosure.adapterApplyReceiptVerified === false &&
        capitalOperatorPacketClosure.adapterApplyReceiptOperatorMayApply === true &&
        typeof capitalOperatorPacketClosure.adapterApplyReceiptNextSafeTask === "string" &&
        capitalOperatorPacketClosure.adapterApplyReceiptNextSafeTask.includes(
          "capital:trade:adapter-ack-apply-receipt:check",
        )) ||
        (capitalOperatorPacketClosure.machineLine.includes("operatorCanExecute=true") &&
          capitalOperatorPacketClosure.adapterApplyReceiptVerified === true &&
          (capitalOperatorPacketClosure.adapterApplyReceiptStatus === "no_apply_required" ||
            capitalOperatorPacketClosure.adapterApplyReceiptStatus ===
              "applied_receipt_verified"))),
    {
      summaryKey: "capitalOperatorPacketClosure.machineLine",
      machineLine: capitalOperatorPacketClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-operator-packet:controlled-runner-summary-sync",
    controlledRunnerScript.includes("adapterApplyReceiptStatus") &&
      controlledRunnerScript.includes("adapterApplyReceiptVerified") &&
      controlledRunnerScript.includes("adapterApplyReceiptOperatorMayApply") &&
      controlledRunnerScript.includes("adapterApplyReceipt=${adapterApplyReceiptStatus}") &&
      controlledRunnerScript.includes(
        "adapterApplyReceiptVerified=${String(adapterApplyReceiptVerified)}",
      ) &&
      controlledRunnerScript.includes(
        "operatorMayApply=${String(adapterApplyReceiptOperatorMayApply)}",
      ) &&
      controlledRunnerScript.includes("capitalOperatorPacketAdapterApplyReceiptStatus") &&
      controlledRunnerScript.includes("capital_operator_packet_adapter_apply_receipt_status"),
    {
      summaryKey: "capitalOperatorPacketClosure.controlledRunnerSync",
      target: "openclaw-controlled-task-runner",
    },
  );
  addCheck(
    checks,
    "capital-local-executor-dispatch:telegram-report-machine-summary",
    capitalLocalExecutorDispatchClosure.reportRead === true &&
      capitalLocalExecutorDispatchClosure.machineLine.includes("capitalLocalExecutorDispatch=") &&
      capitalLocalExecutorDispatchClosure.machineLine.includes("dispatchPolicy=") &&
      capitalLocalExecutorDispatchClosure.noOrderWrite === true &&
      capitalLocalExecutorDispatchClosure.sentOrder === false &&
      // Legacy blocked stage or current final-confirmation-ready stage.
      ((capitalLocalExecutorDispatchClosure.machineLine.includes("operatorCanExecute=false") &&
        capitalLocalExecutorDispatchClosure.machineLine.includes("executorArmed=false") &&
        capitalLocalExecutorDispatchClosure.machineLine.includes(
          "dispatchPolicy=blocked_do_not_send",
        )) ||
        (capitalLocalExecutorDispatchClosure.machineLine.includes("operatorCanExecute=true") &&
          capitalLocalExecutorDispatchClosure.machineLine.includes("executorArmed=true") &&
          capitalLocalExecutorDispatchClosure.machineLine.includes(
            "dispatchPolicy=local_executor_may_dispatch_after_executor_owned_final_confirmation",
          ))),
    {
      summaryKey: "capitalLocalExecutorDispatchClosure.machineLine",
      machineLine: capitalLocalExecutorDispatchClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-local-executor-dispatch:telegram-drilldown",
    tradingCopy.includes("localExecutor") &&
      tradingPanel.includes("buildCapitalLocalExecutorDispatchPanel") &&
      tradingPanel.includes("本地執行器 Dispatch") &&
      tradingPanel.includes("executorArmed") &&
      tradingPanel.includes("payloadHash") &&
      tradingPanel.includes('value: "sc:tr:localexec"') &&
      callbackRouter.includes('case "localexec"') &&
      callbackRouter.includes("fetchCapitalLocalExecutorDispatchState") &&
      callbackRouter.includes(
        "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
      ) &&
      tradingPanelTest.includes("buildCapitalLocalExecutorDispatchPanel") &&
      tradingPanelTest.includes("本地執行器 Dispatch") &&
      tradingPanelTest.includes("sc:tr:localexec") &&
      callbackRouterTest.includes("sc:tr:localexec") &&
      callbackRouterTest.includes("capitalLocalExecutorDispatch=blocked"),
    {
      callback: "sc:tr:localexec",
      summaryKey: "capitalLocalExecutorDispatchClosure.machineLine",
      noOrderWrite: true,
    },
  );
  addCheck(
    checks,
    "capital-live-executor-arm-profile:telegram-report-machine-summary",
    capitalLiveExecutorArmProfileClosure.reportRead === true &&
      capitalLiveExecutorArmProfileClosure.machineLine.includes("capitalLiveExecutorArmProfile=") &&
      // Legacy unarmed/expired stage OR current armed-ready stage.
      ((capitalLiveExecutorArmProfileClosure.machineLine.includes("armed=false") &&
        capitalLiveExecutorArmProfileClosure.machineLine.includes("allowExecutorWrite=false")) ||
        capitalLiveExecutorArmProfileClosure.machineLine.includes("expired=true") ||
        (capitalLiveExecutorArmProfileClosure.machineLine.includes("armed=true") &&
          capitalLiveExecutorArmProfileClosure.machineLine.includes("allowExecutorWrite=true"))) &&
      capitalLiveExecutorArmProfileClosure.noOrderWrite === true &&
      capitalLiveExecutorArmProfileClosure.sentOrder === false,
    {
      summaryKey: "capitalLiveExecutorArmProfileClosure.machineLine",
      machineLine: capitalLiveExecutorArmProfileClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-live-executor-arm-profile:telegram-drilldown",
    tradingCopy.includes("liveExecutorArmProfile") &&
      tradingPanel.includes("buildCapitalLiveExecutorArmProfilePanel") &&
      tradingPanel.includes("Live Executor Arm Profile") &&
      tradingPanel.includes("profileRequirementsObserved") &&
      tradingPanel.includes("killSwitch") &&
      tradingPanel.includes('value: "sc:tr:armprofile"') &&
      callbackRouter.includes('case "armprofile"') &&
      callbackRouter.includes("fetchCapitalLiveExecutorArmProfileState") &&
      callbackRouter.includes("openclaw-capital-live-executor-arm-profile-latest.json") &&
      tradingPanelTest.includes("buildCapitalLiveExecutorArmProfilePanel") &&
      tradingPanelTest.includes("Live Executor Arm Profile") &&
      tradingPanelTest.includes("sc:tr:armprofile") &&
      callbackRouterTest.includes("sc:tr:armprofile") &&
      callbackRouterTest.includes("capitalLiveExecutorArmProfile=unarmed"),
    {
      callback: "sc:tr:armprofile",
      summaryKey: "capitalLiveExecutorArmProfileClosure.machineLine",
      noOrderWrite: true,
    },
  );
  addCheck(
    checks,
    "capital-local-executor-dispatch:controlled-runner-summary-sync",
    controlledRunnerScript.includes("capitalLocalExecutorDispatchMachineLine") &&
      controlledRunnerScript.includes(
        "localExecutor=${tradingShortcutsStatus.capitalLocalExecutorDispatchPublishMachineLine}",
      ) &&
      controlledRunnerScript.includes(
        "本地執行器=${tradingShortcutsStatus.capitalLocalExecutorDispatchPublishMachineLine}",
      ) &&
      controlledRunnerScript.includes("capital_local_executor_dispatch") &&
      controlledRunnerScript.includes("capital_local_executor_dispatch_executor_armed") &&
      controlledRunnerScript.includes("capital_local_executor_dispatch_sent_order"),
    {
      summaryKey: "capitalLocalExecutorDispatchClosure.controlledRunnerSync",
      target: "openclaw-controlled-task-runner",
    },
  );
  addCheck(
    checks,
    "capital-trade-auto-cycle:telegram-report-machine-summary",
    capitalTradeAutoCycleClosure.reportRead === true &&
      capitalTradeAutoCycleClosure.status === "visible_blocked_cycle" &&
      capitalTradeAutoCycleClosure.machineLine.includes("capitalTradeAutoCycle=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("decision=blocked_do_not_send") &&
      capitalTradeAutoCycleClosure.machineLine.includes("quote=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("adapterAck=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("adapterHashOk=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("adapterExpected=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("adapterActual=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("positionFreshness=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("positionAge=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("positionMaxFresh=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("strategyFillGate=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("promotion=blocked_") &&
      capitalTradeAutoCycleClosure.machineLine.includes("freshCandidates=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("freshCandidateCount=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("failedReplayDigest=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("failedReplayActive=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("failedReplayUnlocked=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("freshSameCase=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("freshSameCaseP05=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("oppositeExposure=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("oppositeP05=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("promotionBlockers=") &&
      capitalTradeAutoCycleClosure.machineLine.includes("operatorCanExecute=false") &&
      capitalTradeAutoCycleClosure.machineLine.includes("canTradeInsideOpenClaw=false") &&
      capitalTradeAutoCycleClosure.machineLine.includes("noLiveOrderSent=true") &&
      capitalTradeAutoCycleClosure.machineLine.includes("noOrderWrite=true") &&
      capitalTradeAutoCycleClosure.promotionBlockerMachineLine.includes(
        "promotionBlockers=strategy_fill_gate:",
      ) &&
      capitalTradeAutoCycleClosure.adapterAckBlockerMachineLine.includes("adapterAckBlocker=") &&
      capitalTradeAutoCycleClosure.verifiedPositionBlockerMachineLine.includes(
        "verifiedPositionBlocker=",
      ) &&
      capitalTradeAutoCycleClosure.sentOrder === false,
    {
      summaryKey: "capitalTradeAutoCycleClosure.machineLine",
      machineLine: capitalTradeAutoCycleClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-trade-auto-cycle:controlled-runner-summary-sync",
    controlledRunnerScript.includes("capitalTradeAutoCycleMachineLine") &&
      controlledRunnerScript.includes(
        "autoCycle=${tradingShortcutsStatus.capitalTradeAutoCyclePublishMachineLine}",
      ) &&
      controlledRunnerScript.includes(
        "交易總循環=${tradingShortcutsStatus.capitalTradeAutoCyclePublishMachineLine}",
      ) &&
      controlledRunnerScript.includes("capital_trade_auto_cycle") &&
      controlledRunnerScript.includes("capital_trade_auto_cycle_no_live_order_sent") &&
      controlledRunnerScript.includes("capital_trade_auto_cycle_sent_order"),
    {
      summaryKey: "telegram_trading_shortcuts.capitalTradeAutoCycleMachineLine",
      target: "openclaw-controlled-task-runner.mjs",
    },
  );
  addCheck(
    checks,
    "capital-tail-risk-repair:telegram-report-machine-summary",
    capitalTailRiskRepairClosure.reportRead === true &&
      (capitalTailRiskRepairClosure.status === "visible_candidate_plan" ||
        ["blocked_no_effective_repair_ready", "tail_risk_passed"].includes(
          capitalTailRiskRepairClosure.repairStatus,
        )) &&
      capitalTailRiskRepairClosure.machineLine.includes("capitalTailRiskRepair=") &&
      capitalTailRiskRepairClosure.machineLine.includes("candidatePlan=") &&
      capitalTailRiskRepairClosure.machineLine.includes("buckets=") &&
      capitalTailRiskRepairClosure.machineLine.includes("nextBatch=") &&
      capitalTailRiskRepairClosure.machineLine.includes("excludedFailedReplay=") &&
      capitalTailRiskRepairClosure.machineLine.includes("skippedFailedReplay=") &&
      capitalTailRiskRepairClosure.machineLine.includes("failedReplayHistory=") &&
      capitalTailRiskRepairClosure.machineLine.includes("sameCase=") &&
      capitalTailRiskRepairClosure.machineLine.includes("ranked=") &&
      capitalTailRiskRepairClosure.machineLine.includes("replayOutcome=") &&
      capitalTailRiskRepairClosure.machineLine.includes("nextCommand=") &&
      capitalTailRiskRepairClosure.machineLine.includes("riskReview=") &&
      capitalTailRiskRepairClosure.machineLine.includes("noOrderWrite=true") &&
      capitalTailRiskRepairClosure.nextCommandMachineLine.includes("capitalTailRiskNextCommand=") &&
      capitalTailRiskRepairClosure.nextCommandMachineLine.includes("command=") &&
      capitalTailRiskRepairClosure.nextCommandMachineLine.includes("riskReview=") &&
      capitalTailRiskRepairClosure.failedReplayHistoryMachineLine.includes(
        "capitalFailedReplayHistory=banned:",
      ) &&
      capitalTailRiskRepairClosure.failedReplayHistoryMachineLine.includes("next=") &&
      capitalTailRiskRepairClosure.failedReplayHistoryMachineLine.includes("quality=") &&
      capitalTailRiskRepairClosure.failedReplayHistoryMachineLine.includes("noOrderWrite=true") &&
      capitalTailRiskRepairClosure.sameCaseNoOrderWrite === true &&
      (capitalTailRiskRepairClosure.sameCaseContributionRanking.length > 0 ||
        capitalTailRiskRepairClosure.sameCaseRerunStatus === "blocked_no_candidates") &&
      ["capital:strategy:fill-simulation:check", "capital:trade:current-paper-intents"].some(
        (commandToken) =>
          capitalTailRiskRepairClosure.sameCaseFollowUpCommand.includes(commandToken),
      ) &&
      capitalTailRiskRepairClosure.bucketIds.includes(
        "fresh_resolved_low_correlation_or_opposite_exposure",
      ) &&
      capitalTailRiskRepairClosure.bucketIds.includes("same_case_rerun"),
    {
      summaryKey: "capitalTailRiskRepairClosure.machineLine",
      machineLine: capitalTailRiskRepairClosure.machineLine,
      nextCommandMachineLine: capitalTailRiskRepairClosure.nextCommandMachineLine,
      failedReplayHistoryMachineLine: capitalTailRiskRepairClosure.failedReplayHistoryMachineLine,
    },
  );
  addCheck(
    checks,
    "capital-risk-resized-rejection:telegram-report-machine-summary",
    capitalRiskResizedRejectionClosure.reportRead === true &&
      capitalRiskResizedRejectionClosure.status === "visible_rejection_summary" &&
      capitalRiskResizedRejectionClosure.machineLine.includes("riskResizedRejectionSummary=") &&
      capitalRiskResizedRejectionClosure.machineLine.includes("rejected=") &&
      capitalRiskResizedRejectionClosure.machineLine.includes("p05Pts=") &&
      capitalRiskResizedRejectionClosure.machineLine.includes("p05Notional=") &&
      capitalRiskResizedRejectionClosure.machineLine.includes("noOrderWrite=true") &&
      capitalRiskResizedRejectionClosure.publishMachineLine.includes(
        "riskResizedRejectionSummary=",
      ) &&
      capitalRiskResizedRejectionClosure.publishMachineLine.includes("rejected=") &&
      capitalRiskResizedRejectionClosure.publishMachineLine.includes("p05Pts=") &&
      capitalRiskResizedRejectionClosure.publishMachineLine.includes("p05Notional=") &&
      capitalRiskResizedRejectionClosure.publishMachineLine.includes("noOrderWrite:ok") &&
      !capitalRiskResizedRejectionClosure.publishMachineLine.includes("noOrderWrite=true") &&
      capitalRiskResizedRejectionClosure.noOrderWrite === true &&
      capitalRiskResizedRejectionClosure.sentOrder === false &&
      (capitalRiskResizedRejectionClosure.rejectedSymbols.length > 0 ||
        capitalRiskResizedRejectionClosure.summaryStatus !== "all_candidates_rejected"),
    {
      summaryKey: "capitalRiskResizedRejectionClosure.machineLine",
      machineLine: capitalRiskResizedRejectionClosure.machineLine,
      publishMachineLine: capitalRiskResizedRejectionClosure.publishMachineLine,
    },
  );
  addCheck(
    checks,
    "capital-high-confidence-paper-rerun:telegram-report-machine-summary",
    capitalHighConfidencePaperRerunClosure.reportRead === true &&
      ["visible_blocked", "visible_passed"].includes(
        capitalHighConfidencePaperRerunClosure.status,
      ) &&
      capitalHighConfidencePaperRerunClosure.machineLine.includes("highConfidencePaperRerun=") &&
      capitalHighConfidencePaperRerunClosure.machineLine.includes("requiredConfidence=") &&
      capitalHighConfidencePaperRerunClosure.machineLine.includes("candidates=") &&
      capitalHighConfidencePaperRerunClosure.machineLine.includes("noOrderWrite=true") &&
      capitalHighConfidencePaperRerunClosure.noOrderWrite === true &&
      capitalHighConfidencePaperRerunClosure.sentOrder === false,
    {
      summaryKey: "capitalHighConfidencePaperRerunClosure.machineLine",
      machineLine: capitalHighConfidencePaperRerunClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-high-confidence-paper-rerun:assistant-status-strip-visible",
    tradingPanel.includes("capitalHighConfidencePaperRerunClosure") &&
      tradingPanel.includes("capitalHighConfidence=<code>") &&
      tradingPanel.includes("requiredConfidenceStatus") &&
      tradingPanelTest.includes("capitalHighConfidence=<code>highConfidencePaperRerun=") &&
      tradingPanelTest.includes(
        "requiredConfidenceStatus=<code>impossible_under_current_signal_model</code>",
      ),
    {
      callback: "sc:tr:assist",
      summaryKey: "capitalHighConfidencePaperRerunClosure.machineLine",
    },
  );
  addCheck(
    checks,
    "capital-high-confidence-paper-rerun:callback-summary-refresh",
    callbackRouter.includes("openclaw-capital-high-confidence-paper-rerun-gate-latest.json") &&
      callbackRouter.includes("buildCapitalHighConfidencePaperRerunClosure") &&
      callbackRouter.includes("capitalHighConfidencePaperRerunClosure") &&
      callbackRouterTest.includes("writeCapitalHighConfidencePaperRerunReportFixture") &&
      callbackRouterTest.includes("capitalHighConfidence=<code>highConfidencePaperRerun="),
    {
      callback: "sc:tr:assist",
      report:
        "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
    },
  );
  addCheck(
    checks,
    "capital-verified-position-snapshot:telegram-report-machine-summary",
    capitalVerifiedPositionSnapshotClosure.reportRead === true &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes(
        "capitalVerifiedPositionSnapshot=",
      ) &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes("freshness=") &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes("age=") &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes("maxFresh=") &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes("next=") &&
      capitalVerifiedPositionSnapshotClosure.machineLine.includes("noOrderWrite=true") &&
      capitalVerifiedPositionSnapshotClosure.noOrderWrite === true &&
      capitalVerifiedPositionSnapshotClosure.sentOrder === false,
    {
      summaryKey: "capitalVerifiedPositionSnapshotClosure.machineLine",
      machineLine: capitalVerifiedPositionSnapshotClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "capital-verified-position-snapshot:assistant-status-strip-visible",
    tradingPanel.includes("capitalVerifiedPositionSnapshotClosure") &&
      tradingPanel.includes("capitalPosition=<code>") &&
      tradingPanel.includes("positionFreshness=<code>") &&
      tradingPanelTest.includes("capitalPosition=<code>capitalVerifiedPositionSnapshot=") &&
      tradingPanelTest.includes("positionFreshness=<code>stale</code>"),
    {
      callback: "sc:tr:assist",
      summaryKey: "capitalVerifiedPositionSnapshotClosure.machineLine",
    },
  );
  addCheck(
    checks,
    "capital-verified-position-snapshot:callback-summary-refresh",
    callbackRouter.includes("openclaw-capital-direct-strategy-platform-gate-latest.json") &&
      callbackRouter.includes("buildCapitalVerifiedPositionSnapshotClosure") &&
      callbackRouter.includes("capitalVerifiedPositionSnapshotClosure") &&
      callbackRouterTest.includes("writeCapitalStrategyPlatformReportFixture") &&
      callbackRouterTest.includes("capitalPosition=<code>capitalVerifiedPositionSnapshot="),
    {
      callback: "sc:tr:assist",
      report:
        "reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json",
    },
  );
  const refreshWorkflowReadyOrRecoverable =
    okxCurrentReadinessRefreshWorkflowClosure.status === "ready" ||
    (okxCurrentReadinessClosure.status === "ready" &&
      okxCurrentReadinessHeartbeatOperationClosure.status === "ready" &&
      okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite === true);
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:telegram-report-machine-summary",
    okxCurrentReadinessHeartbeatOperationClosure.status === "ready" &&
      refreshWorkflowReadyOrRecoverable &&
      okxCurrentReadinessInventoryProbeClosure.status === "ready" &&
      okxCurrentReadinessInventoryProbeClosure.machineLine.includes("okxInventoryProbe=") &&
      okxCurrentReadinessInventoryProbeClosure.machineLine.includes("summaryProbes=5/5") &&
      okxCurrentReadinessInventoryProbeClosure.publishProbeCount ===
        okxCurrentReadinessInventoryProbeClosure.publishProbeExpectedCount &&
      okxCurrentReadinessInventoryProbeClosure.machineLine.includes("noOrderWrite=true") &&
      okxCurrentReadinessRefreshWorkflowClosure.machineLine.includes(
        "okxCurrentReadinessRefresh=",
      ) &&
      okxCurrentReadinessRefreshWorkflowClosure.machineLine.includes("steps=") &&
      okxCurrentReadinessRefreshWorkflowClosure.machineLine.includes("noOrderWrite=true") &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes(
        "okxCurrentReadinessHeartbeat=",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes(
        "telegram=sc:tr:okxrefresh",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes(
        "command=okx:current-readiness:refresh",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.schedulerNextRunAt.length > 0 &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes("schedulerNextRunAt=") &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes("inventoryProbe=ready") &&
      okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeMachineLine.includes(
        "okxInventoryProbe=pass",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeNoOrderWrite === true &&
      okxCurrentReadinessHeartbeatOperationClosure.machineLine.includes("noOrderWrite=true"),
    {
      summaryKey: "okxCurrentReadinessHeartbeatOperationClosure.machineLine",
      machineLine: okxCurrentReadinessHeartbeatOperationClosure.machineLine,
      refreshWorkflowMachineLine: okxCurrentReadinessRefreshWorkflowClosure.machineLine,
      inventoryProbeMachineLine: okxCurrentReadinessInventoryProbeClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:status-strip-publish-token-counts",
    okxHeartbeatPublishTokenCountClosure.status === "ready" &&
      okxHeartbeatPublishTokenCountClosure.machineLine.includes(
        "okxHeartbeatPublishTokenCounts=pass",
      ) &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("OKX刷新=1") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("OKX心跳=1") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("OKX合約=1") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("本地執行器=1") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("倉位快照=1") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("noOrderWrite=true=4") &&
      okxHeartbeatPublishTokenCountClosure.summaryZhTw.includes("DMAD=1") &&
      okxHeartbeatPublishTokenCountClosure.noOrderWrite === true &&
      tradingPanel.includes("okxHeartbeatPublishTokenCountClosure") &&
      tradingPanel.includes("okxHeartbeatTokenCounts") &&
      tradingPanelTest.includes("okxHeartbeatTokenCounts=<code>messageTokenCounts") &&
      tradingPanelTest.includes("OKX合約=1") &&
      tradingPanelTest.includes("本地執行器=1") &&
      tradingPanelTest.includes("倉位快照=1") &&
      tradingPanelTest.includes("noOrderWrite=true=4") &&
      tradingPanelTest.includes("DMAD=1") &&
      checkerScript.includes("buildOkxHeartbeatPublishTokenCountClosure") &&
      checkerScript.includes("openclaw-controlled-task-runner-telegram-publish-latest.json"),
    {
      summaryKey: "okxHeartbeatPublishTokenCountClosure.summaryZhTw",
      machineLine: okxHeartbeatPublishTokenCountClosure.machineLine,
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:status-strip-publish-bridge-status",
    okxCurrentReadinessHeartbeatOperationClosure.publishBridgeStatusReady === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteCount === 4 &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractCount === 1 &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateCount === 1 &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "publishBridge=pass",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "upstreamNoOrderWriteVerified=true",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "upstreamDmadGateVerified=true",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "upstreamOkxContractVerified=true",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "noOrderWrite=true=4",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "本地執行器=1",
      ) &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes("OKX合約=1") &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes("DMAD=1") &&
      tradingPanel.includes("okxHeartbeatPublishBridge") &&
      tradingPanel.includes("publishBridgeMachineLine") &&
      tradingPanel.includes("upstreamOkxContractVerified") &&
      tradingPanel.includes("upstreamDmadGateVerified") &&
      tradingPanelTest.includes("okxHeartbeatPublishBridge=<code>publishBridge=pass") &&
      tradingPanelTest.includes("upstreamNoOrderWriteVerified=true") &&
      tradingPanelTest.includes("upstreamOkxContractVerified=true") &&
      tradingPanelTest.includes("upstreamDmadGateVerified=true") &&
      tradingPanelTest.includes("OKX合約=1") &&
      tradingPanelTest.includes("本地執行器=1") &&
      tradingPanelTest.includes("noOrderWrite=true=4") &&
      tradingPanelTest.includes("DMAD=1"),
    {
      callback: "sc:tr:assist",
      summaryKey: "okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine",
      machineLine: okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine,
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:callback-next-action-publish-token-counts",
    callbackRouter.includes("buildOkxHeartbeatPublishTokenCountClosure") &&
      callbackRouter.includes("okxHeartbeatTokenCounts") &&
      callbackRouter.includes("okxHeartbeatSchedulerNextRunAt=<code>") &&
      callbackRouter.includes("openclaw-controlled-task-runner-telegram-publish-latest.json") &&
      callbackRouterTest.includes("writeControlledRunnerTelegramPublishReportFixture") &&
      callbackRouterTest.includes(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      ) &&
      callbackRouterTest.includes("okxHeartbeatTokenCounts=<code>messageTokenCounts") &&
      callbackRouterTest.includes("OKX合約=1") &&
      callbackRouterTest.includes("倉位快照=1") &&
      callbackRouterTest.includes("本地執行器=1") &&
      callbackRouterTest.includes("noOrderWrite=true=4") &&
      callbackRouterTest.includes("DMAD=1") &&
      okxHeartbeatPublishTokenCountClosure.status === "ready",
    {
      callback: "sc:tr:okxrefresh",
      summaryKey: "okxHeartbeatPublishTokenCountClosure.summaryZhTw",
      target: "callback-router.test.ts",
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:callback-next-action-publish-bridge-status",
    callbackRouter.includes("publishBridgeMachineLine") &&
      callbackRouter.includes("okxHeartbeatPublishBridge=<code>") &&
      callbackRouter.includes("upstreamNoOrderWriteVerified") &&
      callbackRouter.includes("upstreamNoOrderWriteCount") &&
      callbackRouter.includes("upstreamExecuteRequiredCount") &&
      callbackRouter.includes("upstreamOkxContractVerified") &&
      callbackRouter.includes("upstreamOkxContractCount") &&
      callbackRouter.includes("upstreamDmadGateVerified") &&
      callbackRouter.includes("upstreamDmadGateCount") &&
      callbackRouterTest.includes("publishBridgeStatus") &&
      callbackRouterTest.includes("okxHeartbeatPublishBridge=<code>publishBridge=pass") &&
      callbackRouterTest.includes("upstreamNoOrderWriteVerified=true") &&
      callbackRouterTest.includes("upstreamOkxContractVerified=true") &&
      callbackRouterTest.includes("upstreamDmadGateVerified=true") &&
      callbackRouterTest.includes("OKX合約=1") &&
      callbackRouterTest.includes("本地執行器=1") &&
      callbackRouterTest.includes("noOrderWrite=true=4") &&
      callbackRouterTest.includes("DMAD=1") &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeStatusReady === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateVerified === true &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteCount === 4 &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractCount === 1 &&
      okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateCount === 1 &&
      okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.includes(
        "noOrderWrite=true=4",
      ),
    {
      callback: "sc:tr:okxrefresh",
      summaryKey: "okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine",
      machineLine: okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine,
    },
  );
  addCheck(
    checks,
    "okx-current-readiness-heartbeat-operation:controlled-runner-summary-sync",
    controlledRunnerScript.includes("okxHeartbeatRefreshMachineLine") &&
      controlledRunnerScript.includes(
        "okxHeartbeat=${tradingShortcutsStatus.okxHeartbeatRefreshMachineLine}",
      ) &&
      controlledRunnerScript.includes(
        "OKX心跳=${tradingShortcutsStatus.okxHeartbeatRefreshMachineLine}",
      ) &&
      controlledRunnerScript.includes("executeRequired=") &&
      controlledRunnerScript.includes("schedulerNextRunAt=") &&
      controlledRunnerScript.includes("noOrderWrite=") &&
      controlledRunnerScript.includes("capitalFailedReplayHistoryMachineLine") &&
      controlledRunnerScript.includes("capital_failed_replay_history") &&
      autonomousInventoryScript.includes(
        "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      ) &&
      autonomousInventoryScript.includes(
        "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-okx-heartbeat-refresh",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-okx-heartbeat-execute-required",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-okx-heartbeat-scheduler-next-run-at",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-okx-heartbeat-no-order-write",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-capital-failed-replay-history",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-summary-capital-failed-replay-no-order-write",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-publish-message-okx-heartbeat-refresh",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-publish-message-okx-heartbeat-execute-required",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-publish-message-okx-heartbeat-scheduler-next-run-at",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-publish-token-summary-no-order-write",
      ) &&
      autonomousInventoryScript.includes(
        "contract-probe:controlled-telegram-publish-token-count-no-order-write",
      ),
    {
      summaryKey: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      capitalFailedReplayHistory:
        "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
      target: "openclaw-controlled-task-runner.mjs",
    },
  );
  addCheck(
    checks,
    "fast-ticket-audit:shortcut-check-count-machine-line",
    checkerScript.includes("function buildShortcutCheckCountClosure(checks)") &&
      checkerScript.includes("checkCountMachineLine: ${shortcutCheckCountClosure.machineLine") &&
      checkerScript.includes("growthReason=assistant+okx+fixture+report-machine") &&
      tradingPanelTest.includes("shortcutChecks=192 failed=0 assistantClosure=42") &&
      tradingPanelTest.includes("okxClosure=18") &&
      tradingPanelTest.includes("fixtureCoverage=4") &&
      tradingPanelTest.includes("reportMachine=12"),
    {
      summaryKey: "shortcutCheckCountClosure.machineLine",
      target: "telegram-shortcuts-report",
    },
  );

  const failedChecks = checks.filter((check) => check.status !== "pass");
  const shortcutCheckCountClosure = buildShortcutCheckCountClosure(checks);
  const fixtureCoverage = buildFixtureCoverageSummary(checks);
  assistantClosureSummary.statusStripFixtureCoverage = {
    status: fixtureCoverage.status,
    checkId: fixtureCoverage.checkId,
    targets: fixtureCoverage.targets,
    visibleInAssistantStatusStrip: hasPassedCheck(
      checks,
      "fast-ticket-audit:assistant-panel-status-strip",
    ),
  };
  const report = {
    schema: "openclaw.telegram-trading-shortcuts.v1",
    generatedAt: new Date().toISOString(),
    repoRoot,
    status: failedChecks.length === 0 ? "pass" : "fail",
    summary: {
      shortcuts: shortcuts.length,
      checks: checks.length,
      failed: failedChecks.length,
      assistantStateEntrypoints: entrypoints,
      fixtureCoverage,
      shortcutCheckCountClosure,
      okxPaperAuditClosure,
      okxCurrentReadinessClosure,
      okxCurrentReadinessRefreshWorkflowClosure,
      okxCurrentReadinessInventoryProbeClosure,
      okxHeartbeatPublishTokenCountClosure,
      okxSchedulerNoOrderContractProbeClosure,
      okxCurrentReadinessHeartbeatOperationClosure,
      capitalOperatorPacketClosure,
      capitalLocalExecutorDispatchClosure,
      capitalLiveExecutorArmProfileClosure,
      capitalTradeAutoCycleClosure,
      capitalTailRiskRepairClosure,
      capitalRiskResizedRejectionClosure,
      capitalHighConfidencePaperRerunClosure,
      capitalVerifiedPositionSnapshotClosure,
      assistantClosure: assistantClosureSummary,
      learningSummaryClosure,
    },
    checks,
    failedChecks,
    files,
  };

  const text = `${JSON.stringify(report, null, 2)}\n`;
  const summaryText = renderMarkdownSummary(report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, text, "utf8");
  fs.writeFileSync(`${reportPath}.sha256`, `${sha256(text)}\n`, "ascii");
  fs.writeFileSync(summaryPath, summaryText, "utf8");
  fs.writeFileSync(`${summaryPath}.sha256`, `${sha256(summaryText)}\n`, "ascii");

  if (failedChecks.length > 0) {
    process.stderr.write(
      `OPENCLAW_TELEGRAM_TRADING_SHORTCUTS_CHECK=FAIL failed=${failedChecks.length}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("OPENCLAW_TELEGRAM_TRADING_SHORTCUTS_CHECK=OK\n");
  process.stdout.write(`status=${report.status}\n`);
  process.stdout.write(`checks=${checks.length}\n`);
  process.stdout.write(`report=${reportPath}\n`);
  process.stdout.write(`summary=${summaryPath}\n`);
}

main();
