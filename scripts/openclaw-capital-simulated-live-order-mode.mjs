import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const SCHEMA = "openclaw.capital.simulated-live-order-mode.v1";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function isPartialJsonRead(error) {
  return (
    error instanceof SyntaxError &&
    /Unexpected end of JSON input|Unterminated string|Expected/u.test(error.message)
  );
}

async function readJsonIfExists(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
        return null;
      }
      lastError = error;
      if (isPartialJsonRead(error) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function readLatestJsonLineIfExists(filePath) {
  try {
    const lines = (await fs.readFile(filePath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep scanning older lines; the stream may contain a partial final line.
      }
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

async function readCurrentPromotionGate({ repoRoot, stateRoot }) {
  try {
    const result = await runCapitalLiveTradingPromotionGate({
      mergeMapPath: path.join(stateRoot, "openclaw-capital-angry-bohr-merge-map-latest.json"),
      paperGatePath: path.join(
        repoRoot,
        ".openclaw",
        "trading",
        "capital-paper-promotion-gate.json",
      ),
      approvalPath: path.join(repoRoot, "config", "capital-live-trading-approval.json"),
      simulationPath: path.join(stateRoot, "openclaw-capital-thousand-run-simulation-latest.json"),
      fullChainPath: path.join(
        stateRoot,
        "openclaw-capital-full-chain-simulation-gate-latest.json",
      ),
      walkForwardPath: path.join(stateRoot, "openclaw-capital-qmd-walk-forward-gate-latest.json"),
      reportPath: path.join(stateRoot, "openclaw-capital-live-trading-promotion-gate-latest.json"),
      writeState: false,
    });
    return result?.report ?? null;
  } catch {
    return readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-live-trading-promotion-gate-latest.json"),
    );
  }
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
  };
  for (const arg of argv) {
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    }
  }
  return options;
}

function accountAllowlistSummary({ approval, service }) {
  const approvalAccounts = Array.isArray(approval?.accountAllowlist)
    ? approval.accountAllowlist
    : [];
  const serviceAccounts = Array.isArray(service?.accounts) ? service.accounts : [];
  const accounts = approvalAccounts.length > 0 ? approvalAccounts : serviceAccounts;
  return {
    count: accounts.length,
    source:
      approvalAccounts.length > 0
        ? "config/capital-live-trading-approval.json"
        : "hft_service_status.json",
    valuesRedacted: true,
    sha256: sha256Text(JSON.stringify(accounts)),
  };
}

function inferBrokerApi({ symbol, service }) {
  const normalized = String(symbol || "").toUpperCase();
  const overseasSymbols = new Set(
    Array.isArray(service?.subscribedOsStocks)
      ? service.subscribedOsStocks.map((item) => String(item).toUpperCase())
      : [],
  );
  const domesticSymbols = new Set(
    Array.isArray(service?.subscribedStocks)
      ? service.subscribedStocks.map((item) => String(item).toUpperCase())
      : [],
  );
  if (overseasSymbols.has(normalized)) {
    return "SendOverseaFutureOrder";
  }
  if (domesticSymbols.has(normalized)) {
    return "SendFutureOrder";
  }
  if (/^(CL|QM|MCL|BZ|CN|CD|GC|SI|NQ|MNQ|ES|MES|YM|MYM|RTY|M2K)/u.test(normalized)) {
    return "SendOverseaFutureOrder";
  }
  return "SendFutureOrder";
}

function parseIntentTimestamp(intent) {
  const candidates = [
    intent?.generatedAt,
    intent?.sourceEvent?.receivedAt,
    intent?.sourceEvent?.time,
  ];
  for (const candidate of candidates) {
    const timestamp = Date.parse(candidate || "");
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return 0;
}

function chooseLatestIntent(intents) {
  return (
    intents
      .filter(Boolean)
      .sort((left, right) => parseIntentTimestamp(right) - parseIntentTimestamp(left))[0] || null
  );
}

function normalizeDayTradeMode(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[-\s]/gu, "_");
  if (["day", "daytrade", "day_trade", "intraday"].includes(normalized)) {
    return "day_trade";
  }
  if (["overnight", "normal", "non_day_trade", "nondaytrade"].includes(normalized)) {
    return "overnight";
  }
  return "";
}

function buildBlockers({
  fullChain,
  readiness,
  promotion,
  approval,
  service,
  paperIntent,
  accountSummary,
}) {
  const blockers = [];
  const readinessBlockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const readinessQuoteOnlyBlocked =
    readiness?.schema === "openclaw.capital.live-strategy-readiness.v1" &&
    readiness?.status === "blocked" &&
    readinessBlockers.length > 0 &&
    readinessBlockers.every(
      (id) => id === "service:domestic-quote-fresh" || id === "service:overseas-quote-fresh",
    ) &&
    readiness?.capabilities?.liveStrategyExecution === false &&
    readiness?.capabilities?.liveTradingExecution === false &&
    readiness?.capabilities?.brokerWriteExecution === false;
  const readinessPaperSafe =
    readiness?.schema === "openclaw.capital.live-strategy-readiness.v1" &&
    (readiness?.status === "paper_ready_live_blocked" || readinessQuoteOnlyBlocked);
  if (
    fullChain?.schema !== "openclaw.capital.full-chain-simulation-gate.v1" ||
    fullChain?.status !== "passed"
  ) {
    blockers.push("full-chain-simulation-gate-not-passed");
  }
  if (!readinessPaperSafe) {
    blockers.push("live-strategy-readiness-not-paper-ready");
  }
  const promotionReadyForManualReview =
    promotion?.schema === "openclaw.capital.live-trading-promotion-gate.v1" &&
    promotion?.status === "live_ready" &&
    promotion?.readyForManualReview === true;
  const promotionBlocked =
    promotion?.schema === "openclaw.capital.live-trading-promotion-gate.v1" &&
    promotion?.status === "blocked";
  if (!promotionReadyForManualReview && !promotionBlocked) {
    blockers.push("live-promotion-gate-state-unexpected");
  }
  if (service?.status !== "running" || service?.loginStatus !== "connected") {
    blockers.push("capital-hft-service-not-connected");
  }
  if (service?.orderInitialized !== true) {
    blockers.push("order-channel-not-initialized");
  }
  if (approval?.safety?.allowLiveTrading === true || approval?.safety?.writeBrokerOrders === true) {
    blockers.push("approval-file-live-write-is-enabled");
  }
  if (Number(service?.orderStats?.sent ?? 0) !== 0) {
    blockers.push("service-order-stats-sent-not-zero");
  }
  if (!paperIntent) {
    blockers.push("paper-intent-missing");
  }
  if (accountSummary.count <= 0) {
    blockers.push("account-allowlist-empty");
  }
  return blockers;
}

function buildWarnings({ service }) {
  const warnings = [];
  if (
    service?.riskControls?.allowLiveTrading === true ||
    service?.riskControls?.writeBrokerOrders === true
  ) {
    warnings.push("service-live-write-enabled-observed");
  }
  return warnings;
}

function buildSimulatedOrder({ paperIntent, service, accountSummary, requestedTrade }) {
  const symbol = paperIntent?.symbol || "UNKNOWN";
  const dayTradeMode =
    normalizeDayTradeMode(paperIntent?.dayTradeMode) ||
    normalizeDayTradeMode(paperIntent?.holdingMode) ||
    normalizeDayTradeMode(requestedTrade?.holdingMode);
  return {
    intentId: paperIntent?.intentId || "",
    provider: "capital",
    mode: "simulated_live_paper_only",
    routingDecision: "paper-simulated",
    brokerCommandSuppressed: true,
    wouldUseBrokerApi: inferBrokerApi({ symbol, service }),
    symbol,
    symbolName: paperIntent?.symbolName || "",
    side: paperIntent?.side || paperIntent?.direction || "",
    orderType: paperIntent?.orderType || "paper_limit",
    dayTradeMode,
    holdingMode: dayTradeMode,
    quantity: Number(paperIntent?.quantity ?? 1),
    price: paperIntent?.price ?? null,
    stopLoss: paperIntent?.stopLoss ?? null,
    takeProfit: paperIntent?.takeProfit ?? null,
    ttlMs: paperIntent?.ttlMs ?? null,
    sourceEvent: {
      eventSource: paperIntent?.sourceEvent?.eventSource || "",
      receivedAt: paperIntent?.sourceEvent?.receivedAt || paperIntent?.sourceEvent?.time || "",
      close: paperIntent?.sourceEvent?.close ?? null,
      bid: paperIntent?.sourceEvent?.bid ?? null,
      ask: paperIntent?.sourceEvent?.ask ?? null,
      qty: paperIntent?.sourceEvent?.qty ?? null,
    },
    accountAllowlist: accountSummary,
  };
}

export async function buildCapitalSimulatedLiveOrderMode(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");

  const [
    fullChain,
    readiness,
    promotion,
    approval,
    service,
    latestPaperIntent,
    streamPaperIntent,
    directStatus,
  ] = await Promise.all([
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-full-chain-simulation-gate-latest.json"),
    ),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-live-strategy-readiness-latest.json")),
    readCurrentPromotionGate({ repoRoot, stateRoot }),
    readJsonIfExists(path.join(repoRoot, "config", "capital-live-trading-approval.json")),
    readJsonIfExists(path.join(capitalRoot, "hft_service_status.json")),
    readJsonIfExists(path.join(tradingRoot, "capital-paper-intent-latest.json")),
    readLatestJsonLineIfExists(path.join(tradingRoot, "capital-paper-intents.jsonl")),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-direct-operation-status-latest.json")),
  ]);
  const paperIntent = chooseLatestIntent([latestPaperIntent, streamPaperIntent]);
  const accountSummary = accountAllowlistSummary({ approval, service });
  const blockers = buildBlockers({
    fullChain,
    readiness,
    promotion,
    approval,
    service,
    paperIntent,
    accountSummary,
  });
  const warnings = buildWarnings({ service });
  const simulatedOrder = paperIntent
    ? buildSimulatedOrder({
        paperIntent,
        service,
        accountSummary,
        requestedTrade: directStatus?.summary?.requestedTrade,
      })
    : null;
  const enabled = blockers.length === 0;
  const generatedAt = new Date().toISOString();
  const event = {
    eventId: `capital-simlive-${sha256Text(`${generatedAt}:${paperIntent?.intentId || ""}`).slice(0, 16)}`,
    generatedAt,
    status: enabled ? "enabled_simulated_live" : "blocked",
    routingDecision: simulatedOrder?.routingDecision || "blocked",
    symbol: simulatedOrder?.symbol || "",
    brokerCommandSuppressed: true,
    sentOrder: false,
  };

  return {
    schema: SCHEMA,
    generatedAt,
    status: enabled ? "enabled_simulated_live" : "blocked",
    mode: "simulated_live_paper_only",
    scope: {
      repoRoot,
      capitalRoot,
      statePath: path.join(stateRoot, "openclaw-capital-simulated-live-order-mode-latest.json"),
      tradingPath: path.join(tradingRoot, "capital-simulated-live-order-mode.json"),
    },
    prerequisites: {
      fullChainGate: {
        schema: fullChain?.schema || "missing",
        status: fullChain?.status || "missing",
        runs: fullChain?.summary?.runs ?? 0,
        stageFailedCount: fullChain?.summary?.stageFailedCount ?? null,
        faultFailedCount: fullChain?.summary?.faultFailedCount ?? null,
      },
      readiness: {
        schema: readiness?.schema || "missing",
        status: readiness?.status || "missing",
        paperStrategyExecution: readiness?.capabilities?.paperStrategyExecution === true,
      },
      livePromotion: {
        schema: promotion?.schema || "missing",
        status: promotion?.status || "missing",
        blockerCode: promotion?.blockerCode || "",
        blockers: Array.isArray(promotion?.blockers) ? promotion.blockers : [],
      },
      service: {
        status: service?.status || "missing",
        loginStatus: service?.loginStatus || "missing",
        orderInitialized: service?.orderInitialized === true,
        certificateLoaded: service?.certificateLoaded === true,
        domesticQuoteFreshAt: service?.quoteStats?.lastQuoteAt || "",
        overseasQuoteFreshAt: service?.osQuoteStats?.lastQuoteAt || "",
      },
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerOrderPathEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      paperOnly: true,
      brokerCommandFileWrite: false,
      humanApproved: approval?.humanApproved === true,
      approvalFileLiveWrite: approval?.safety?.writeBrokerOrders === true,
      serviceLiveWrite: service?.riskControls?.writeBrokerOrders === true,
    },
    simulatedOrder,
    event,
    blockers,
    warnings,
    nextSafeTask: enabled
      ? "模擬真單 paper-only lane 已開啟；下一步把 PreTradeRiskGate / SEMI approval / latency-gap instrumentation 固定接到送單前，真單仍 blocked。"
      : "先解除 blockers，重跑 pnpm capital-hft:capital:simulated-live:check；真單仍 blocked。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const report = await buildCapitalSimulatedLiveOrderMode({ repoRoot });
  const statePath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-simulated-live-order-mode-latest.json",
  );
  const tradingPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-simulated-live-order-mode.json",
  );
  const eventsPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-simulated-live-orders.jsonl",
  );
  if (options.writeState || options.check) {
    await writeJsonWithSha(statePath, report);
    await writeJsonWithSha(tradingPath, report);
    await appendJsonLine(eventsPath, report.event);
  }
  if (options.check) {
    if (report.status !== "enabled_simulated_live") {
      throw new Error(
        `CAPITAL_SIMULATED_LIVE_ORDER_MODE_BLOCKED blockers=${report.blockers.join(",")}`,
      );
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_SIMULATED_LIVE_ORDER_MODE=${report.status} routing=${report.simulatedOrder?.routingDecision || "blocked"} sentOrder=${report.safety.sentOrder} blockers=${report.blockers.join(",") || "none"}\n`,
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
