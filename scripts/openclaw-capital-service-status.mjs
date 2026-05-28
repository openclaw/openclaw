import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";
import { readCapitalQuoteStatus } from "./openclaw-capital-quote-status.mjs";

const CAPITAL_ROOT =
  process.env.OPENCLAW_CAPITAL_HFT_SERVICE_ROOT || "D:\\群益及元大API\\CapitalHftService";
const DEFAULT_PANEL_PATH = path.join(".openclaw", "quote", "capital-service-status.json");
const DEFAULT_SERVICE_STATUS_FRESH_SECONDS = 120;
const DEFAULT_NON_BLOCKING_REQUIRED_IDS = ["a50-hot"];
const DEFAULT_REPORT_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-service-status-latest.json",
);

function bool(value) {
  return value === true;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function readJson(filePath, fallback = null) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "ENOTDIR") {
        return fallback;
      }
      lastError = error;
      if (
        error instanceof SyntaxError &&
        /Unexpected end of JSON input/u.test(error.message) &&
        attempt < 2
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  throw new Error(
    `Invalid JSON while reading Capital service status dependency: ${filePath}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
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

function readyStatus(capability) {
  return capability?.status === "ready";
}

function statusText(ok, readyLabel = "READY", blockedLabel = "BLOCKED") {
  return ok ? readyLabel : blockedLabel;
}

function quoteStatusText(quote) {
  if (quote?.ready) {
    return "READY";
  }
  if (quote?.status === "session_closed" || quote?.freshnessStatus === "session_closed") {
    return "SESSION_CLOSED";
  }
  return "BLOCKED";
}

function orderModeCaseLabel(entry) {
  const market = entry?.market === "overseas" ? "海外" : "國內";
  const mode = entry?.holdingMode === "Overnight" ? "非當沖" : "當沖";
  return `${market}${mode}`;
}

function summarizeOrderModes(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    return "missing";
  }
  const failed = cases.filter((entry) => entry?.ok !== true || entry?.sentToBroker === true);
  if (failed.length > 0) {
    return `BLOCKED:${failed.map(orderModeCaseLabel).join(",")}`;
  }
  return `${cases.map(orderModeCaseLabel).join("/")}:READY`;
}

function summarizeTelegramPoller(poller) {
  if (!poller?.available) {
    return "missing";
  }
  if (poller.duplicatePollerDetected) {
    return "衝突:duplicate_poller_detected";
  }
  if (poller.pollingEnabled) {
    return `衝突:capital_polling_enabled:${poller.pollingOwner || "unknown"}`;
  }
  if (poller.pollState === "running") {
    return "READY";
  }
  if (poller.pollState === "disabled") {
    return "disabled";
  }
  if (poller.pollState === "disabled_by_owner_gate") {
    return `send-only:${poller.pollingOwner || "openclaw_gateway"}`;
  }
  if (poller.pollState === "stopped") {
    return "stopped";
  }
  if (poller.pollState === "poll_error") {
    return `ERROR:${poller.lastPollErrorStatus || "poll_error"}`;
  }
  return poller.pollState || "unknown";
}

function maxProductAgeSeconds(products) {
  const ages = (Array.isArray(products) ? products : [])
    .map((product) => Number(product?.ageSeconds))
    .filter((age) => Number.isFinite(age));
  return ages.length > 0 ? Math.max(...ages) : null;
}

function parseNonBlockingRequiredIds() {
  const raw = process.env.OPENCLAW_CAPITAL_NON_BLOCKING_REQUIRED_IDS;
  if (typeof raw !== "string" || raw.trim() === "") {
    return new Set(DEFAULT_NON_BLOCKING_REQUIRED_IDS);
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function parseTimestampMs(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const normalized = value.replace(/(\.\d{3})\d+([Z+-])/u, "$1$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSecondsSince(value, now) {
  const timestampMs = parseTimestampMs(value);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, Math.round((now.getTime() - timestampMs) / 1000));
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function defaultPidExists(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function buildServiceRecovery({ capitalRoot, serviceLivenessStatus, launcherExists }) {
  const launcherPath = path.join(capitalRoot, "run-capital-hft-service-persistent.ps1");
  const launcherStatePath = path.join(
    capitalRoot,
    "state",
    "capital_hft_service_persistent_launcher_latest.json",
  );
  const recoveryRequired = serviceLivenessStatus !== "alive";
  return {
    required: recoveryRequired,
    reason: recoveryRequired ? serviceLivenessStatus : "",
    mode: "operator_paper_only_restart",
    launcherPath,
    launcherExists,
    launcherStatePath,
    command: launcherExists
      ? [
          "powershell",
          "-NoProfile",
          "-ExecutionPolicy Bypass",
          "-File",
          powerShellSingleQuoted(launcherPath),
          "-Start",
          "-WaitSeconds 12",
          "-Json",
        ].join(" ")
      : "",
    autoExecutedByOpenClaw: false,
    requiresOperator: true,
    validationCommands: ["pnpm capital:service-status:check", "pnpm capital:quote:status:check"],
    safety: {
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      telegramPolling: false,
    },
  };
}

function summarizeServiceLiveness({ hasStatus, pid, pidAlive, statusFresh }) {
  if (!hasStatus) {
    return "missing_status";
  }
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return "missing_pid";
  }
  if (!pidAlive) {
    return "dead_pid";
  }
  if (!statusFresh) {
    return "stale_status";
  }
  return "alive";
}

function matrixQuoteReason(matrix) {
  const summary = matrix?.summary ?? {};
  if (summary.requiredReady === true) {
    return "核心必要商品 fresh matched：可回報即時價。";
  }
  const sessionClosed = Array.isArray(summary.sessionClosedRequiredIds)
    ? summary.sessionClosedRequiredIds
    : [];
  const blocked = Array.isArray(summary.blockedRequiredIds) ? summary.blockedRequiredIds : [];
  const sessionClosedSet = new Set(sessionClosed);
  const nonSessionBlocked = blocked.filter((id) => !sessionClosedSet.has(id));
  if (sessionClosed.length > 0) {
    const parts = [`核心必要商品目前非交易時段：${sessionClosed.join(",")}`];
    if (nonSessionBlocked.length > 0) {
      parts.push(`仍未 fresh matched：${nonSessionBlocked.join(",")}`);
    }
    return `${parts.join("；")}；不可回舊價，等待 fresh callback。`;
  }
  return blocked.length > 0
    ? `核心必要商品未 fresh matched：${blocked.join(",")}`
    : "核心必要商品 freshness matrix 尚未 ready。";
}

function quoteNextSafeTask({ quoteReady, quoteStatus, freshnessMatrix }) {
  if (quoteReady) {
    return "";
  }
  if (quoteStatus === "session_closed") {
    return "等待國內期貨交易時段恢復後確認 fresh callback；期間不可回舊價。";
  }
  const summary = freshnessMatrix?.summary ?? {};
  const blocked = Array.isArray(summary.blockedRequiredIds) ? summary.blockedRequiredIds : [];
  const sessionClosed = Array.isArray(summary.sessionClosedRequiredIds)
    ? summary.sessionClosedRequiredIds
    : [];
  if (blocked.length > 0) {
    const sessionText =
      sessionClosed.length > 0 ? `；其中非交易時段=${sessionClosed.join(",")}` : "";
    return `修復 quote freshness：${blocked.join(",")}${sessionText}；不可用舊價，等待或重刷正確訂閱 callback。`;
  }
  return "修復 quote freshness gate；不可用舊價，需確認商品代號、交易時段、訂閱與 callback。";
}

function buildReplyLine(report) {
  const liveReason = report.liveOrders.reason || "unknown";
  return [
    `[OpenClaw Capital 狀態] 報價=${quoteStatusText(report.quote)}`,
    `查詢=${statusText(report.positionQuery.ready)}`,
    `模擬=${statusText(report.paperTrading.ready)}`,
    `真單=${report.liveOrders.ready ? "READY" : `封鎖:${liveReason}`}`,
    `服務=${report.service.status}:${report.service.livenessStatus}`,
    `watchdog=${report.watchdog.status}`,
    `dry-run=${report.orderMode.status}`,
    `下單模式=${report.orderMode.summary}`,
    `Telegram=${report.telegramPoller.summary}`,
    report.safety.sentOrder ? "已送單=是" : "未送單",
    "不可回舊價",
  ].join("｜");
}

function deriveBlockerCode({
  safeOperationalReady,
  serviceLivenessStatus,
  quoteStatus,
  quoteReady,
  positionReady,
  paperReady,
  watchdogReady,
  telegramPoller,
  sentOrder,
  riskLiveEnabled,
  riskWriteEnabled,
}) {
  if (safeOperationalReady) {
    return "";
  }
  if (serviceLivenessStatus === "dead_pid") {
    return "capital_hft_service_dead_pid";
  }
  if (serviceLivenessStatus === "stale_status") {
    return "capital_hft_service_status_stale";
  }
  if (serviceLivenessStatus === "missing_status") {
    return "capital_hft_service_status_missing";
  }
  if (serviceLivenessStatus === "missing_pid") {
    return "capital_hft_service_pid_missing";
  }
  if (telegramPoller?.pollingEnabled) {
    return "capital_telegram_polling_enabled";
  }
  if (telegramPoller?.duplicatePollerDetected) {
    return "duplicate_poller_detected";
  }
  if (quoteStatus === "session_closed") {
    return "market_session_closed";
  }
  if (!quoteReady) {
    return "capital_quote_not_fresh_matched";
  }
  if (!positionReady) {
    return "capital_position_query_not_ready";
  }
  if (!paperReady) {
    return "capital_paper_trading_not_ready";
  }
  if (!watchdogReady) {
    return "capital_watchdog_not_ready";
  }
  if (sentOrder || riskLiveEnabled || riskWriteEnabled) {
    return "capital_safety_gate_violation";
  }
  return "capital_service_blocked_or_degraded";
}

function buildFailedSteps({
  serviceRuntimeReady,
  serviceLivenessStatus,
  serviceStatusFresh,
  servicePidAlive,
  quoteReady,
  quoteStatus,
  positionReady,
  paperReady,
  watchdogReady,
  telegramControlReady,
  sentOrder,
  riskLiveEnabled,
  riskWriteEnabled,
}) {
  return [
    serviceRuntimeReady ? null : `service_liveness:${serviceLivenessStatus}`,
    serviceStatusFresh ? null : "service_status_fresh",
    servicePidAlive ? null : "service_pid_alive",
    quoteReady ? null : `quote_fresh_matched:${quoteStatus || "unknown"}`,
    positionReady ? null : "position_query_ready",
    paperReady ? null : "paper_trading_ready",
    watchdogReady ? null : "watchdog_ready",
    telegramControlReady ? null : "telegram_single_owner",
    sentOrder ? "safety_sent_order_false" : null,
    riskLiveEnabled ? "safety_allow_live_trading_false" : null,
    riskWriteEnabled ? "safety_write_broker_orders_false" : null,
  ].filter(Boolean);
}

export async function readCapitalServiceStatus(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot || CAPITAL_ROOT);
  const capitalStateDir = path.join(capitalRoot, "state");
  const now = options.now instanceof Date ? options.now : new Date();
  const recoveryLauncherPath = path.join(capitalRoot, "run-capital-hft-service-persistent.ps1");
  const [
    watchdog,
    paperOrderMode,
    cycle,
    capability,
    riskControls,
    hftStatus,
    freshnessMatrix,
    recoveryLauncherExists,
  ] = await Promise.all([
    readJson(path.join(capitalStateDir, "capital_hft_service_watchdog_latest.json"), null),
    readJson(path.join(capitalStateDir, "capital_paper_order_mode_dryrun_latest.json"), null),
    readJson(path.join(capitalStateDir, "capital_live_order_unlock_cycle_latest.json"), null),
    readJson(path.join(capitalStateDir, "capital_capability_status_latest.json"), null),
    readJson(path.join(capitalRoot, "risk-controls.json"), null),
    readJson(path.join(capitalRoot, "hft_service_status.json"), null),
    readCapitalCoreProductFreshnessMatrix({
      repoRoot,
      stateDir: capitalRoot,
      now,
    }).catch(() => null),
    pathExists(recoveryLauncherPath),
  ]);
  let strictQuoteStatus = null;
  let strictQuoteStatusError = "";
  try {
    strictQuoteStatus = await readCapitalQuoteStatus({
      repoRoot,
      stateDir: capitalRoot,
      now,
      preferServiceStatus: false,
    });
  } catch (error) {
    strictQuoteStatusError = error instanceof Error ? error.message : String(error);
  }

  const capabilities = capability?.capabilities ?? {};
  const capabilityQuoteReady = readyStatus(capabilities.realtimeQuotes);
  const strictQuoteAvailable = strictQuoteStatus !== null;
  const matrixAvailable =
    freshnessMatrix?.schema === "openclaw.capital.core-product-freshness-matrix.v1";
  const matrixBlockedRequiredIds = Array.isArray(freshnessMatrix?.summary?.blockedRequiredIds)
    ? freshnessMatrix.summary.blockedRequiredIds
    : [];
  const nonBlockingRequiredIds = parseNonBlockingRequiredIds();
  const matrixHardBlockedRequiredIds = matrixBlockedRequiredIds.filter(
    (id) => !nonBlockingRequiredIds.has(id),
  );
  const matrixRequiredReady = matrixAvailable && matrixHardBlockedRequiredIds.length === 0;
  const matrixSoftBlockedRequiredIds = matrixBlockedRequiredIds.filter((id) =>
    nonBlockingRequiredIds.has(id),
  );
  const matrixSessionClosedRequiredIds = Array.isArray(
    freshnessMatrix?.summary?.sessionClosedRequiredIds,
  )
    ? freshnessMatrix.summary.sessionClosedRequiredIds
    : [];
  const matrixSessionClosedSet = new Set(matrixSessionClosedRequiredIds);
  const matrixNonSessionBlockedRequired = matrixHardBlockedRequiredIds.filter(
    (id) => !matrixSessionClosedSet.has(id),
  );
  const matrixOnlySessionClosedRequired =
    matrixHardBlockedRequiredIds.length > 0 &&
    matrixSessionClosedRequiredIds.length > 0 &&
    matrixNonSessionBlockedRequired.length === 0;
  const quoteReady = matrixAvailable
    ? matrixRequiredReady
    : strictQuoteAvailable
      ? bool(strictQuoteStatus.ready) && strictQuoteStatus.quoteProof?.freshnessStatus === "fresh"
      : false;
  const quoteStatus = matrixAvailable
    ? matrixRequiredReady
      ? "fresh"
      : matrixOnlySessionClosedRequired
        ? "session_closed"
        : text(freshnessMatrix?.status, "blocked")
    : strictQuoteAvailable
      ? text(strictQuoteStatus.status, "unknown")
      : strictQuoteStatusError
        ? "strict_quote_check_failed"
        : text(capabilities.realtimeQuotes?.status, "unknown");
  const quoteReason = matrixAvailable
    ? matrixSoftBlockedRequiredIds.length > 0 && matrixHardBlockedRequiredIds.length === 0
      ? `核心必要商品 soft-blocked 已忽略：${matrixSoftBlockedRequiredIds.join(",")}；其餘 required 已 fresh matched。`
      : matrixQuoteReason(
          matrixHardBlockedRequiredIds.length < matrixBlockedRequiredIds.length
            ? {
                ...freshnessMatrix,
                summary: {
                  ...freshnessMatrix?.summary,
                  blockedRequiredIds: matrixHardBlockedRequiredIds,
                },
              }
            : freshnessMatrix,
        )
    : strictQuoteAvailable
      ? text(strictQuoteStatus.reason)
      : strictQuoteStatusError || text(capabilities.realtimeQuotes?.reason);
  const positionReady = readyStatus(capabilities.positionQuery);
  const paperReady = readyStatus(capabilities.paperTrading);
  const liveReady = readyStatus(capabilities.liveOrders) && bool(capability?.liveTradingReady);
  const liveReason =
    text(capabilities.liveOrders?.reason) ||
    text(capability?.firstBlocker?.reason) ||
    text(capability?.actionableBlocker?.id) ||
    "unknown";
  const paperOnlyMode = bool(capability?.service?.paperOnlyMode);
  const watchdogReady = bool(watchdog?.ready);
  const watchdogStatus = text(watchdog?.status, watchdog ? "unknown" : "missing");
  const orderModeReady = paperOrderMode?.status === "pass";
  const orderModeCases = Array.isArray(paperOrderMode?.cases)
    ? paperOrderMode.cases.map((entry) => ({
        id: entry.id,
        ok: bool(entry.ok),
        market: text(entry.market),
        holdingMode: text(entry.resolved?.holdingMode),
        sentToBroker: bool(entry.sentToBroker),
      }))
    : [];
  const orderModeSummary = summarizeOrderModes(orderModeCases);
  const cycleReady = bool(cycle?.ready);
  const riskLiveEnabled = bool(riskControls?.allowLiveTrading);
  const riskWriteEnabled = bool(riskControls?.writeBrokerOrders);
  const sentOrder = bool(paperOrderMode?.sentOrder) || bool(cycle?.safety?.sentOrder);
  const servicePid = capability?.service?.pid ?? hftStatus?.pid ?? null;
  const serviceStatusGeneratedAt = text(hftStatus?.generatedAt);
  const serviceStatusAgeSeconds = ageSecondsSince(serviceStatusGeneratedAt, now);
  const serviceFreshSeconds = Number.isFinite(Number(options.serviceStatusFreshSeconds))
    ? Number(options.serviceStatusFreshSeconds)
    : DEFAULT_SERVICE_STATUS_FRESH_SECONDS;
  const serviceStatusFresh =
    serviceStatusAgeSeconds !== null && serviceStatusAgeSeconds <= serviceFreshSeconds;
  const pidExists = typeof options.pidExists === "function" ? options.pidExists : defaultPidExists;
  const servicePidAlive = await pidExists(servicePid);
  const serviceLivenessStatus = summarizeServiceLiveness({
    hasStatus: hftStatus !== null,
    pid: servicePid,
    pidAlive: servicePidAlive,
    statusFresh: serviceStatusFresh,
  });
  const serviceRuntimeReady = serviceLivenessStatus === "alive";
  const telegramStatus =
    hftStatus?.telegram && typeof hftStatus.telegram === "object" ? hftStatus.telegram : null;
  const telegramPoller = {
    available: telegramStatus !== null,
    pollingEnabled: bool(telegramStatus?.pollingEnabled),
    pollingOwner: text(telegramStatus?.pollingOwner, telegramStatus ? "unknown" : "missing"),
    pollState: text(telegramStatus?.pollState, telegramStatus ? "unknown" : "missing"),
    duplicatePollerDetected: bool(telegramStatus?.duplicatePollerDetected),
    duplicatePollerCount: Number.isFinite(Number(telegramStatus?.duplicatePollerCount))
      ? Number(telegramStatus.duplicatePollerCount)
      : 0,
    consecutivePollErrors: Number.isFinite(Number(telegramStatus?.consecutivePollErrors))
      ? Number(telegramStatus.consecutivePollErrors)
      : 0,
    lastPollOkAt: text(telegramStatus?.lastPollOkAt),
    lastPollErrorAt: text(telegramStatus?.lastPollErrorAt),
    lastPollErrorStatus: text(telegramStatus?.lastPollErrorStatus),
    lastPollErrorMessage: text(telegramStatus?.lastPollErrorMessage),
    lastDuplicatePollerAt: text(telegramStatus?.lastDuplicatePollerAt),
  };
  telegramPoller.ready =
    telegramPoller.available &&
    !telegramPoller.duplicatePollerDetected &&
    !telegramPoller.pollingEnabled &&
    telegramPoller.pollState !== "poll_error";
  telegramPoller.summary = summarizeTelegramPoller(telegramPoller);
  const telegramControlReady =
    !telegramPoller.available ||
    (!telegramPoller.duplicatePollerDetected &&
      !telegramPoller.pollingEnabled &&
      telegramPoller.pollState !== "poll_error");
  const safeOperationalReady =
    quoteReady &&
    positionReady &&
    paperReady &&
    serviceRuntimeReady &&
    watchdogReady &&
    telegramControlReady &&
    !sentOrder &&
    !riskLiveEnabled &&
    !riskWriteEnabled;
  const failedSteps = buildFailedSteps({
    serviceRuntimeReady,
    serviceLivenessStatus,
    serviceStatusFresh,
    servicePidAlive,
    quoteReady,
    quoteStatus,
    positionReady,
    paperReady,
    watchdogReady,
    telegramControlReady,
    sentOrder,
    riskLiveEnabled,
    riskWriteEnabled,
  });
  const blockerCode = deriveBlockerCode({
    safeOperationalReady,
    serviceLivenessStatus,
    quoteStatus,
    quoteReady,
    positionReady,
    paperReady,
    watchdogReady,
    telegramPoller,
    sentOrder,
    riskLiveEnabled,
    riskWriteEnabled,
  });
  const recovery = buildServiceRecovery({
    capitalRoot,
    serviceLivenessStatus,
    launcherExists: recoveryLauncherExists,
  });

  const report = {
    schema: "openclaw.capital.service-status.v1",
    generatedAt: now.toISOString(),
    status: safeOperationalReady ? "ready_safe" : "blocked_or_degraded",
    ready: safeOperationalReady,
    source: "CapitalHftService state snapshots",
    blockerCode,
    failedSteps,
    capitalRoot,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    service: {
      status: paperOnlyMode ? "paper-only" : text(capability?.service?.source, "unknown"),
      pid: servicePid,
      pidAlive: servicePidAlive,
      ready: serviceRuntimeReady,
      livenessStatus: serviceLivenessStatus,
      statusGeneratedAt: serviceStatusGeneratedAt,
      statusAgeSeconds: serviceStatusAgeSeconds,
      statusFresh: serviceStatusFresh,
      statusFreshSeconds: serviceFreshSeconds,
      loginStatus: text(capability?.service?.loginStatus, text(hftStatus?.loginStatus)),
      loginCode: capability?.service?.loginCode ?? hftStatus?.loginCode ?? null,
      loginMethod: text(capability?.service?.loginMethod, text(hftStatus?.loginMethod)),
      quoteMonitorConnected: bool(
        capability?.service?.quoteMonitorConnected ?? hftStatus?.quoteMonitorConnected,
      ),
      osQuoteConnected: bool(capability?.service?.osQuoteConnected ?? hftStatus?.osQuoteConnected),
      orderInitialized: bool(capability?.service?.orderInitialized ?? hftStatus?.orderInitialized),
      paperOnlyMode,
    },
    recovery,
    telegramPoller,
    quote: {
      ready: quoteReady,
      status: quoteStatus,
      reason: quoteReason,
      strictGateSource: matrixAvailable
        ? "capital_core_product_freshness_matrix"
        : strictQuoteAvailable
          ? "capital_quote_status"
          : "capital_capability_fallback",
      strictGateError: strictQuoteStatusError,
      legacyStrictGateSource: strictQuoteAvailable ? "capital_quote_status" : "",
      legacyStrictGateStatus: text(strictQuoteStatus?.status),
      capabilityReady: capabilityQuoteReady,
      freshnessStatus: matrixAvailable
        ? matrixRequiredReady
          ? "fresh"
          : quoteStatus === "session_closed"
            ? "session_closed"
            : text(freshnessMatrix?.status, "blocked")
        : text(strictQuoteStatus?.quoteProof?.freshnessStatus),
      freshnessAgeSeconds: matrixAvailable
        ? maxProductAgeSeconds(
            (freshnessMatrix?.products ?? []).filter((product) => product?.required),
          )
        : (strictQuoteStatus?.quoteProof?.freshnessAgeSeconds ?? null),
      freshnessTimeBasis: matrixAvailable
        ? "capital_core_product_freshness_matrix"
        : text(strictQuoteStatus?.quoteProof?.timeBasis),
      brokerMarketTime: text(strictQuoteStatus?.quoteProof?.brokerMarketTime),
      receivedAgeSeconds: strictQuoteStatus?.quoteProof?.receivedAgeSeconds ?? null,
      callbackReportableCount: capabilities.realtimeQuotes?.callbackReportableCount ?? null,
      callbackFreshMatchedCount: capabilities.realtimeQuotes?.callbackFreshMatchedCount ?? null,
      matrixSummary: freshnessMatrix?.summary ?? null,
      nonBlockingRequiredIds: Array.from(nonBlockingRequiredIds),
      softBlockedRequiredIds: matrixSoftBlockedRequiredIds,
      hardBlockedRequiredIds: matrixHardBlockedRequiredIds,
    },
    positionQuery: {
      ready: positionReady,
      status: text(capabilities.positionQuery?.status, "unknown"),
      reason: text(capabilities.positionQuery?.reason),
      accountCount: capabilities.positionQuery?.accountCount ?? null,
      overseasPositionUseful: bool(capabilities.positionQuery?.overseasPositionUseful),
      rightsUseful: bool(capabilities.positionQuery?.rightsUseful),
    },
    paperTrading: {
      ready: paperReady,
      status: text(capabilities.paperTrading?.status, "unknown"),
      reason: text(capabilities.paperTrading?.reason),
      maxPositionContracts: capabilities.paperTrading?.maxPositionContracts ?? null,
      maxDailyPaperLossTwd: capabilities.paperTrading?.maxDailyPaperLossTwd ?? null,
    },
    liveOrders: {
      ready: liveReady,
      status: text(capabilities.liveOrders?.status, "unknown"),
      reason: liveReason,
      blocker: liveReady ? null : liveReason,
    },
    riskControlsObserved: {
      allowLiveTrading: riskLiveEnabled,
      writeBrokerOrders: riskWriteEnabled,
      liveActivationEnabled: riskControls?.liveActivation?.enabled === true,
      liveDeactivationEnabled: riskControls?.liveDeactivation?.enabled === true,
      sourcePath: path.join(capitalRoot, "risk-controls.json"),
      reportOnly: true,
    },
    watchdog: {
      ready: watchdogReady,
      status: watchdogStatus,
      blockerCode: watchdog?.blockerCode ?? null,
      restartAttempted: bool(watchdog?.restart?.attempted),
      restartSucceeded: bool(watchdog?.restart?.succeeded),
      domesticFresh: bool(watchdog?.decision?.quoteFreshness?.domestic?.fresh),
      overseasFresh: bool(watchdog?.decision?.quoteFreshness?.overseas?.fresh),
    },
    orderMode: {
      ready: orderModeReady,
      status: text(paperOrderMode?.status, "missing"),
      summary: orderModeSummary,
      failedSteps: Array.isArray(paperOrderMode?.failedSteps) ? paperOrderMode.failedSteps : [],
      cases: orderModeCases,
    },
    unlockCycle: {
      ready: cycleReady,
      status: text(cycle?.status, "missing"),
      failedSteps: Array.isArray(cycle?.failedSteps) ? cycle.failedSteps : [],
      rollbackPaperOnly: bool(cycle?.capabilityAfterRollback?.service?.paperOnlyMode),
    },
    safety: {
      sentOrder,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      paperOnlyMode,
      staleQuoteReturned: matrixAvailable
        ? !matrixRequiredReady
        : strictQuoteAvailable && strictQuoteStatus?.quoteProof?.freshnessStatus !== "fresh",
      realOrderAllowed: false,
    },
    files: {
      watchdog: path.join(capitalStateDir, "capital_hft_service_watchdog_latest.json"),
      paperOrderMode: path.join(capitalStateDir, "capital_paper_order_mode_dryrun_latest.json"),
      unlockCycle: path.join(capitalStateDir, "capital_live_order_unlock_cycle_latest.json"),
      capability: path.join(capitalStateDir, "capital_capability_status_latest.json"),
      riskControls: path.join(capitalRoot, "risk-controls.json"),
      panel: path.join(repoRoot, DEFAULT_PANEL_PATH),
      report: path.join(repoRoot, DEFAULT_REPORT_PATH),
    },
    nextSafeTask: safeOperationalReady
      ? "將 service status 定期併入 Telegram /quote status 與 OpenClaw 狀態面板。"
      : serviceLivenessStatus === "dead_pid"
        ? "用 paper-only / allowLiveTrading=false / writeBrokerOrders=false 重啟 CapitalHftService，確認 PID 存活後再驗證 callback 回流。"
        : serviceLivenessStatus === "stale_status"
          ? "修復 CapitalHftService 狀態寫入或 watchdog；目前 hft_service_status.json 已過期。"
          : serviceLivenessStatus === "missing_status" || serviceLivenessStatus === "missing_pid"
            ? "先建立有效 hft_service_status.json 與 PID 回報，再驗證報價/回報/查詢。"
            : telegramPoller.pollingEnabled
              ? "用不帶 --telegram-polling 的方式重啟 CapitalHftService，讓 OpenClaw Gateway 成為唯一 Telegram getUpdates owner。"
              : telegramPoller.duplicatePollerDetected
                ? "停止或改用 webhook 其中一個 Telegram getUpdates poller，確保同一 bot token 只有一個長輪詢來源。"
                : !quoteReady
                  ? quoteNextSafeTask({ quoteReady, quoteStatus, freshnessMatrix })
                  : riskLiveEnabled || riskWriteEnabled
                    ? "先執行 pnpm capital:live-trading:operator:auto-deactivate 產生 operator 去活化報告；確認後再用 execute 關閉 risk-controls live/write 旗標。"
                    : "先修復 blocked_or_degraded 的 capability/watchdog/orderMode，再回報狀態。",
  };
  report.replyLine = buildReplyLine(report);
  return report;
}

export async function writeCapitalServiceStatus(report, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const panelPath = path.resolve(options.panelPath || path.join(repoRoot, DEFAULT_PANEL_PATH));
  const reportPath = path.resolve(options.reportPath || path.join(repoRoot, DEFAULT_REPORT_PATH));
  await writeJsonWithHash(panelPath, report);
  await writeJsonWithHash(reportPath, report);
  return { panelPath, reportPath };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalRoot: CAPITAL_ROOT,
    panelPath: "",
    reportPath: "",
    writeState: false,
    json: false,
    strictExit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--capital-root") {
      options.capitalRoot = argv[++index] ?? options.capitalRoot;
    } else if (arg.startsWith("--capital-root=")) {
      options.capitalRoot = arg.slice("--capital-root=".length);
    } else if (arg === "--panel") {
      options.panelPath = argv[++index] ?? options.panelPath;
    } else if (arg.startsWith("--panel=")) {
      options.panelPath = arg.slice("--panel=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict-exit") {
      options.strictExit = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await readCapitalServiceStatus(options);
  const outputs = options.writeState ? await writeCapitalServiceStatus(report, options) : {};
  const payload = {
    ...report,
    outputPath: outputs.panelPath ?? "",
    reportPath: outputs.reportPath ?? "",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.replyLine}\n`);
  }
  process.exitCode =
    report.safety.sentOrder || report.safety.allowLiveTrading || report.safety.writeBrokerOrders
      ? 2
      : options.strictExit && !report.ready
        ? 2
        : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital service status failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
