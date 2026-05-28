import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const SCHEMA = "openclaw.capital.live-order-dry-run-pretrade-gate.v1";
const VERIFIED_POSITION_SNAPSHOT_SCHEMA = "openclaw.capital.verified-position-snapshot.v1";
const EXTERNAL_BROKER_ADAPTER_ACK_SCHEMA = "openclaw.capital.external-broker-adapter-ack.v1";
const LEGACY_DOMESTIC_ORDER_SYMBOLS = new Map([
  ["TX00AM", "TX00"],
  ["TX00PM", "TX00"],
  ["TX06AM", "TX06"],
  ["TX06PM", "TX06"],
]);
const isTrue = (value) => value === true;
const isFalse = (value) => value === false;

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
      const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
      if (!text) {
        return null;
      }
      return JSON.parse(text);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
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
    check: false,
    json: false,
    writeState: false,
  };
  for (const arg of argv) {
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    }
  }
  return options;
}

function sideToBroker(value) {
  const side = String(value || "").toLowerCase();
  if (["short", "sell", "s"].includes(side)) {
    return {
      buySell: "sell",
      sBuySell: 1,
    };
  }
  return {
    buySell: "buy",
    sBuySell: 0,
  };
}

function orderModeFromDraft(draft) {
  const raw = String(draft?.dayTradeMode || "")
    .toLowerCase()
    .replace(/[-\s]/gu, "_");
  if (["day", "daytrade", "day_trade", "intraday"].includes(raw)) {
    return "day_trade";
  }
  if (["overnight", "normal", "non_day_trade", "nondaytrade"].includes(raw)) {
    return "overnight";
  }
  return "";
}

function tradeTypeFromOrder(orderType) {
  const type = String(orderType || "").toUpperCase();
  if (type.includes("FOK")) {
    return {
      tradeType: "FOK",
      sTradeType: 2,
      specialTradeType: 0,
    };
  }
  if (type.includes("IOC")) {
    return {
      tradeType: "IOC",
      sTradeType: 1,
      specialTradeType: 0,
    };
  }
  if (type.includes("MARKET")) {
    return {
      tradeType: "ROD",
      sTradeType: 0,
      specialTradeType: 1,
    };
  }
  return {
    tradeType: "ROD",
    sTradeType: 0,
    specialTradeType: 0,
  };
}

function brokerStructForApi(api) {
  return api === "SendOverseaFutureOrder" ? "OVERSEAFUTUREORDER" : "FUTUREORDER";
}

function resolveOrderSymbol(symbol) {
  const sourceSymbol = String(symbol || "")
    .trim()
    .toUpperCase();
  const stockNo = LEGACY_DOMESTIC_ORDER_SYMBOLS.get(sourceSymbol) || sourceSymbol;
  return {
    sourceSymbol,
    stockNo,
    route: stockNo === sourceSymbol ? "direct" : "legacy_domestic_alias_rewritten",
  };
}

function exchangeFromService(service, symbol) {
  const normalized = String(symbol || "").toUpperCase();
  const products = Array.isArray(service?.osProducts) ? service.osProducts : [];
  const found = products.find(
    (item) => String(item?.stockNo || item?.symbol || "").toUpperCase() === normalized,
  );
  return found?.exchangeNo || found?.exchange || "";
}

function collectRiskBlockers({
  diagnostics,
  promotion,
  approval,
  service,
  riskControls,
  simulatedLive,
  orderMode,
  liveRuntimeEnabled,
}) {
  const blockers = [];
  blockers.push("agent-broker-write-disabled");
  const promotionReadyForManualReview =
    promotion?.status === "live_ready" && promotion?.readyForManualReview === true;
  if (liveRuntimeEnabled) {
    if (simulatedLive?.schema !== "openclaw.capital.simulated-live-order-mode.v1") {
      blockers.push("simulated-live-order-mode-missing");
    }
    if (
      simulatedLive?.safety?.sentOrder !== false ||
      simulatedLive?.safety?.writeBrokerOrders !== false
    ) {
      blockers.push("simulated-live-safety-mismatch");
    }
    if (diagnostics?.schema !== "openclaw.capital.simulation-diagnostics.v1") {
      blockers.push("simulation-diagnostics-missing");
    }
    if (!orderMode) {
      blockers.push("order:day-trade-mode-explicit-required");
    }
    return [...new Set(blockers.filter(Boolean))];
  }
  if (simulatedLive?.schema !== "openclaw.capital.simulated-live-order-mode.v1") {
    blockers.push("simulated-live-order-mode-missing");
  }
  if (simulatedLive?.status !== "enabled_simulated_live") {
    blockers.push("simulated-live-order-mode-not-enabled");
  }
  if (
    simulatedLive?.safety?.sentOrder !== false ||
    simulatedLive?.safety?.writeBrokerOrders !== false
  ) {
    blockers.push("simulated-live-safety-mismatch");
  }
  if (diagnostics?.schema !== "openclaw.capital.simulation-diagnostics.v1") {
    blockers.push("simulation-diagnostics-missing");
  }
  if (!promotionReadyForManualReview) {
    for (const item of Array.isArray(diagnostics?.hardBlockers) ? diagnostics.hardBlockers : []) {
      if (String(item?.severity || "").toLowerCase() === "high") {
        blockers.push(item.id);
      }
    }
  }
  if (!promotionReadyForManualReview) {
    for (const item of Array.isArray(promotion?.blockers) ? promotion.blockers : []) {
      blockers.push(item);
    }
  }
  if (!["blocked", "live_ready"].includes(String(promotion?.status || ""))) {
    blockers.push("live-promotion-gate-state-unexpected");
  }
  if (approval?.humanApproved !== true) {
    blockers.push("live:human-approval-pending");
  }
  if (approval?.killSwitch !== true || !approval?.rollbackPlan) {
    blockers.push("live:kill-switch-and-rollback");
  }
  if (
    service?.riskControls?.allowLiveTrading === true ||
    service?.riskControls?.writeBrokerOrders === true ||
    riskControls?.allowLiveTrading === true ||
    riskControls?.writeBrokerOrders === true
  ) {
    blockers.push("live-broker-write-is-enabled");
  }
  if (Number(service?.orderStats?.sent ?? 0) !== 0) {
    blockers.push("service-order-stats-sent-not-zero");
  }
  if (!orderMode) {
    blockers.push("order:day-trade-mode-explicit-required");
  }
  return [...new Set(blockers.filter(Boolean))];
}

function isLiveRuntimeEnabled({ riskControls, service, approval }) {
  const runtimeSource = riskControls ?? service?.riskControls ?? {};
  const runtimeLive =
    runtimeSource?.allowLiveTrading === true && runtimeSource?.writeBrokerOrders === true;
  const manualApprovalReady =
    approval?.humanApproved === true &&
    approval?.killSwitch === true &&
    typeof approval?.rollbackPlan === "string" &&
    approval.rollbackPlan.trim().length > 0;
  return runtimeLive && manualApprovalReady && false;
}

function buildLiveOrderDraft({
  simulatedLive,
  service,
  forceDayTrade = false,
  suppressBrokerCommand = true,
}) {
  const simulatedOrder = simulatedLive?.simulatedOrder || {};
  const brokerApi = simulatedOrder.wouldUseBrokerApi || "SendFutureOrder";
  const brokerStruct = brokerStructForApi(brokerApi);
  const mode = orderModeFromDraft(simulatedOrder) || (forceDayTrade ? "day_trade" : "");
  const side = sideToBroker(simulatedOrder.side);
  const trade = tradeTypeFromOrder(simulatedOrder.orderType);
  const symbolRoute = resolveOrderSymbol(simulatedOrder.symbol);
  const symbol = symbolRoute.stockNo;
  const price = simulatedOrder.price == null ? "" : String(simulatedOrder.price);
  const quantity = Math.max(1, Number(simulatedOrder.quantity ?? 1));
  const requestId = `dryrun-${sha256Text(`${simulatedOrder.intentId || ""}:${symbolRoute.sourceSymbol}:${symbol}:${price}:${quantity}`).slice(0, 16)}`;
  const baseCommand = {
    command:
      brokerApi === "SendOverseaFutureOrder" ? "send_oversea_future_order" : "send_future_order",
    requestId,
    stockNo: symbol,
    buySell: side.buySell,
    price,
    qty: quantity,
    tradeType: trade.tradeType,
    dayTradeMode: mode || "explicit_required",
    dayTrade: mode === "day_trade",
    newClose: false,
    specialTradeType: trade.specialTradeType,
  };
  const brokerFields = {
    bstrStockNo: symbol,
    sBuySell: side.sBuySell,
    sTradeType: trade.sTradeType,
    sDayTrade: mode === "day_trade" ? 1 : 0,
    bstrPrice: price,
    nQty: quantity,
  };
  if (brokerApi === "SendOverseaFutureOrder") {
    baseCommand.exchangeNo = exchangeFromService(service, symbol);
    baseCommand.yearMonth = "";
    brokerFields.bstrExchangeNo = baseCommand.exchangeNo;
    brokerFields.bstrYearMonth = "";
    brokerFields.sSpecialTradeType = trade.specialTradeType;
    brokerFields.sNewClose = 0;
  }
  return {
    provider: "capital",
    mode: "live_order_shape_dry_run_only",
    sourceIntentId: simulatedOrder.intentId || "",
    brokerApi,
    brokerStruct,
    symbolRoute,
    routingDecision: suppressBrokerCommand ? "quarantine-only" : "ready_to_dispatch",
    brokerCommandSuppressed: suppressBrokerCommand,
    commandPayload: baseCommand,
    brokerFields,
    sourceEvent: simulatedOrder.sourceEvent || {},
    stops: {
      stopLoss: simulatedOrder.stopLoss ?? null,
      takeProfit: simulatedOrder.takeProfit ?? null,
    },
    accountAllowlist: simulatedOrder.accountAllowlist || {
      count: 0,
      source: "missing",
      valuesRedacted: true,
      sha256: "",
    },
    supportedModes: [
      {
        id: "day_trade",
        sDayTrade: 1,
        meaning: "當沖單",
      },
      {
        id: "overnight",
        sDayTrade: 0,
        meaning: "非當沖/留倉單",
      },
    ],
    exactBrokerSendSuppressed: suppressBrokerCommand,
  };
}

function positionSymbol(position) {
  return String(
    position?.stockNo || position?.symbol || position?.contract || position?.contractCode || "",
  )
    .trim()
    .toUpperCase();
}

function signedPositionQuantity(position) {
  const rawQuantity =
    position?.netContracts ?? position?.qty ?? position?.quantity ?? position?.contracts ?? 0;
  const quantity = Number(rawQuantity);
  if (!Number.isFinite(quantity)) {
    return 0;
  }
  const side = String(position?.side || position?.direction || "")
    .trim()
    .toLowerCase();
  if (["short", "sell", "s"].includes(side)) {
    return -Math.abs(quantity);
  }
  if (["flat", "none"].includes(side)) {
    return 0;
  }
  return quantity;
}

function summarizeVerifiedPositionSnapshot({ snapshot, snapshotPath, targetSymbol }) {
  const input = {
    path: snapshotPath,
    exists: snapshot != null,
    expectedSchema: VERIFIED_POSITION_SNAPSHOT_SCHEMA,
    template: {
      schema: VERIFIED_POSITION_SNAPSHOT_SCHEMA,
      verified: true,
      verifiedAt: "ISO-8601",
      verifiedBy: "operator",
      positions: [
        {
          symbol: targetSymbol,
          side: "long|short|flat",
          qty: 0,
        },
      ],
    },
  };
  if (snapshot == null) {
    return {
      ...input,
      status: "missing",
      usable: false,
      reason: "verified position snapshot missing",
      positionCount: 0,
      matchedPositionCount: 0,
      targetSymbol,
      netContracts: 0,
      hasOpenPosition: false,
    };
  }

  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  const matchedPositions = positions.filter(
    (position) => positionSymbol(position) === targetSymbol,
  );
  const netContracts = matchedPositions.reduce(
    (total, position) => total + signedPositionQuantity(position),
    0,
  );
  const schemaOk = snapshot.schema === VERIFIED_POSITION_SNAPSHOT_SCHEMA;
  const verified = snapshot.verified === true;
  const usable = schemaOk && verified;

  return {
    ...input,
    status: !schemaOk ? "invalid_schema" : verified ? "verified" : "not_verified",
    usable,
    verifiedAt: String(snapshot.verifiedAt || ""),
    verifiedBy: String(snapshot.verifiedBy || ""),
    positionCount: positions.length,
    matchedPositionCount: matchedPositions.length,
    targetSymbol,
    netContracts,
    hasOpenPosition: netContracts !== 0,
  };
}

function buildPositionDecision(positionSnapshot) {
  if (positionSnapshot.usable !== true) {
    return {
      status: "blocked_no_verified_position_snapshot",
      conclusion:
        "不能判斷目前倉位是否應出場，因為 OpenClaw 未呼叫帳戶查詢 API，也沒有可用的 verified position snapshot。",
    };
  }
  if (positionSnapshot.hasOpenPosition !== true) {
    return {
      status: "verified_flat_no_exit_required",
      conclusion:
        "已讀人工 verified position snapshot：目標商品目前無倉位，不需要出場；是否進場仍需 fresh quote 與全部 pre-trade gate 通過。",
    };
  }
  return {
    status: "verified_open_position_auto_exit_eligible",
    conclusion:
      "已讀 verified position snapshot：目標商品有未平倉；在 fresh quote 與風控 gate 皆通過時，可由自動化策略執行出場。",
  };
}

function summarizeExternalBrokerAdapterAck({ ack, ackPath, sealedIntentSha256 }) {
  const rollbackVerifiedAt = String(ack?.rollback?.verifiedAt || "");
  const input = {
    path: ackPath,
    exists: ack != null,
    expectedSchema: EXTERNAL_BROKER_ADAPTER_ACK_SCHEMA,
    requiredSealedIntentSha256: sealedIntentSha256,
    template: {
      schema: EXTERNAL_BROKER_ADAPTER_ACK_SCHEMA,
      adapterId: "operator-capital-live-adapter",
      owner: "operator",
      sealedIntentSha256,
      canary: {
        status: "pass",
        dryRun: true,
        sentOrder: false,
      },
      rollback: {
        status: "pass",
        verifiedAt: rollbackVerifiedAt,
      },
    },
  };
  if (ack == null) {
    return {
      ...input,
      status: "missing",
      usable: false,
      reason: "external broker adapter ack missing",
    };
  }

  const schemaOk = ack.schema === EXTERNAL_BROKER_ADAPTER_ACK_SCHEMA;
  const hashOk = String(ack.sealedIntentSha256 || "").toUpperCase() === sealedIntentSha256;
  const canaryPass =
    ack.canary?.status === "pass" && ack.canary?.dryRun === true && ack.canary?.sentOrder === false;
  const rollbackPass = ack.rollback?.status === "pass";
  const ownerOk = String(ack.owner || "").toLowerCase() === "operator";
  const usable = schemaOk && ownerOk && hashOk && canaryPass && rollbackPass;

  return {
    ...input,
    status: usable ? "verified" : "blocked",
    usable,
    schemaOk,
    ownerOk,
    hashOk,
    canaryPass,
    rollbackPass,
    rollbackVerifiedAt,
    adapterId: String(ack.adapterId || ""),
    reason: usable
      ? "external broker adapter canary and rollback ack verified"
      : "external broker adapter ack incomplete or not matched to sealed intent",
  };
}

function buildOperatorHandoff({
  liveOrderDraft,
  blockers,
  positionSnapshot,
  positionSnapshotPath,
  externalAdapterAck,
  externalAdapterAckPath,
  allowedToSend,
}) {
  const positionSnapshotSummary = summarizeVerifiedPositionSnapshot({
    snapshot: positionSnapshot,
    snapshotPath: positionSnapshotPath,
    targetSymbol: liveOrderDraft.commandPayload.stockNo,
  });
  const sealedOrderIntent = {
    schema: "openclaw.capital.sealed-order-intent.v1",
    status: allowedToSend ? "ready_for_dispatch" : "blocked_candidate_intent",
    destination: "external_operator_owned_broker_adapter",
    brokerWriteAllowedByOpenClaw: allowedToSend,
    commandPayload: liveOrderDraft.commandPayload,
    brokerFields: liveOrderDraft.brokerFields,
    stops: liveOrderDraft.stops,
    blockers,
  };
  const sealedIntentSha256 = sha256Text(JSON.stringify(sealedOrderIntent));
  const externalAdapterAckSummary = summarizeExternalBrokerAdapterAck({
    ack: externalAdapterAck,
    ackPath: externalAdapterAckPath,
    sealedIntentSha256,
  });
  return {
    schema: "openclaw.capital.operator-handoff.v1",
    status: allowedToSend ? "operator_adapter_ready" : "manual_operator_required",
    collaborationMode: "openclaw_to_operator_owned_broker_adapter",
    automatedBrokerWriteAllowed: allowedToSend,
    operatorOwnedBrokerAdapterAllowed: true,
    operatorMustUseBrokerUi: false,
    brokerUiFallbackOnly: !allowedToSend,
    requestedActionPolicy: allowedToSend
      ? "dispatch_live_order_via_operator_owned_broker_adapter"
      : "produce_sealed_order_intent_without_codex_broker_write",
    externalBrokerAdapter: {
      required: true,
      owner: "operator",
      status: allowedToSend
        ? externalAdapterAckSummary.usable
          ? "ready"
          : "blocked_missing_adapter_ack"
        : "blocked_until_adapter_and_all_live_gates_pass",
      dispatcherContract: "scripts/strategy-engine/hft/HftBrokerDispatcher.mjs",
      brokerAdapterContractCheck: "scripts/check-openclaw-broker-adapter-contract.mjs",
      ack: externalAdapterAckSummary,
      currentLivePolicy: allowedToSend ? "live_runtime_enabled" : "blocked_live_promotion",
    },
    positionSnapshot: positionSnapshotSummary,
    positionDecision: buildPositionDecision(positionSnapshotSummary),
    tradeDecision: {
      status: allowedToSend ? "live_order_ready_to_send" : "blocked_until_fresh_quote_and_position",
      symbol: liveOrderDraft.commandPayload.stockNo,
      brokerApi: liveOrderDraft.brokerApi,
      dayTradeMode: liveOrderDraft.commandPayload.dayTradeMode,
      conclusion: allowedToSend
        ? "真實下單已開放：允許透過 operator-owned broker adapter 執行送單。"
        : "不進場、不出場；等待 fresh quote、明確當沖模式、verified position snapshot、simulation/promotion gate 全部通過。",
    },
    handoffPacket: {
      sealedOrderIntent: {
        ...sealedOrderIntent,
        sha256: sealedIntentSha256,
      },
      commandPayload: liveOrderDraft.commandPayload,
      brokerFields: liveOrderDraft.brokerFields,
      stops: liveOrderDraft.stops,
      blockers,
    },
    validationCommands: [
      "pnpm capital:service-status",
      "pnpm capital:quote:status",
      "pnpm capital:overseas-stale-recovery",
      "pnpm capital:live-risk-positions:gate",
      "pnpm capital:live-order-dry-run",
      "node scripts/check-openclaw-broker-adapter-contract.mjs --json",
      "pnpm capital-hft:hft-broker-dispatcher:check",
    ],
  };
}

export async function buildCapitalLiveOrderDryRunPretradeGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const positionSnapshotPath = path.join(
    repoRoot,
    "config",
    "capital-verified-position-snapshot.json",
  );
  const externalAdapterAckPath = path.join(tradingRoot, "capital-external-broker-adapter-ack.json");
  const [
    simulatedLive,
    diagnostics,
    promotion,
    approval,
    service,
    riskControls,
    positionSnapshot,
    externalAdapterAck,
  ] = await Promise.all([
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-simulated-live-order-mode-latest.json"),
    ),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-simulation-diagnostics-latest.json")),
    readCurrentPromotionGate({ repoRoot, stateRoot }),
    readJsonIfExists(path.join(repoRoot, "config", "capital-live-trading-approval.json")),
    readJsonIfExists(path.join(capitalRoot, "hft_service_status.json")),
    readJsonIfExists(path.join(capitalRoot, "risk-controls.json")),
    readJsonIfExists(positionSnapshotPath),
    readJsonIfExists(externalAdapterAckPath),
  ]);
  const liveRuntimeEnabled = isLiveRuntimeEnabled({ riskControls, service, approval });
  const orderMode =
    orderModeFromDraft(simulatedLive?.simulatedOrder) || (liveRuntimeEnabled ? "day_trade" : "");
  const liveOrderDraft = buildLiveOrderDraft({
    simulatedLive,
    service,
    forceDayTrade: liveRuntimeEnabled,
    suppressBrokerCommand: true,
  });
  const blockers = collectRiskBlockers({
    diagnostics,
    promotion,
    approval,
    service,
    riskControls,
    simulatedLive,
    orderMode,
    liveRuntimeEnabled,
  });
  const allowedToSend = liveRuntimeEnabled && blockers.length === 0;
  liveOrderDraft.brokerCommandSuppressed = !allowedToSend;
  liveOrderDraft.exactBrokerSendSuppressed = !allowedToSend;
  liveOrderDraft.routingDecision = allowedToSend ? "ready_to_dispatch" : "quarantine-only";
  const generatedAt = new Date().toISOString();
  const event = {
    eventId: `capital-live-dryrun-pretrade-${sha256Text(`${generatedAt}:${liveOrderDraft.sourceIntentId}`).slice(0, 16)}`,
    generatedAt,
    symbol: liveOrderDraft.commandPayload.stockNo,
    brokerApi: liveOrderDraft.brokerApi,
    allowedToSend,
    sentOrder: false,
    blockers,
  };
  const operatorHandoff = buildOperatorHandoff({
    liveOrderDraft,
    blockers,
    positionSnapshot,
    positionSnapshotPath,
    externalAdapterAck,
    externalAdapterAckPath,
    allowedToSend,
  });
  return {
    schema: SCHEMA,
    generatedAt,
    status: allowedToSend ? "live_order_ready_to_send" : "live_order_dry_run_pretrade_blocked",
    decision: allowedToSend ? "live_order_dispatch_allowed" : "quarantine_only_do_not_send",
    scope: {
      repoRoot,
      capitalRoot,
      statePath: path.join(
        stateRoot,
        "openclaw-capital-live-order-dry-run-pretrade-gate-latest.json",
      ),
      tradingPath: path.join(tradingRoot, "capital-live-order-dry-run-pretrade-gate.json"),
      quarantinePath: path.join(tradingRoot, "capital-live-order-dry-run-quarantine.jsonl"),
    },
    liveOrderDraft,
    preTradeRiskGate: {
      attachedBeforeBrokerSend: true,
      evaluated: true,
      result: allowedToSend ? "pass" : "blocked",
      allowedToSend,
      blockerCount: blockers.length,
      blockers,
    },
    safety: {
      liveTradingEnabled: liveRuntimeEnabled,
      writeBrokerOrders: liveRuntimeEnabled,
      brokerOrderPathEnabled: allowedToSend,
      brokerCommandFileWrite: allowedToSend,
      quarantineOnly: !allowedToSend,
      brokerCommandSuppressed: !allowedToSend,
      sentOrder: false,
      noLiveOrderSent: true,
      approvalFileMutated: false,
      productionApprovalWrite: false,
    },
    operatorHandoff,
    inputs: {
      simulatedLiveStatus: simulatedLive?.status || "missing",
      simulationDiagnosticsStatus: diagnostics?.status || "missing",
      promotionStatus: promotion?.status || "missing",
      serviceStatus: service?.status || "missing",
      serviceLoginStatus: service?.loginStatus || "missing",
      runtimeAllowLiveTrading: riskControls?.allowLiveTrading === true,
      runtimeWriteBrokerOrders: riskControls?.writeBrokerOrders === true,
      orderInitialized: service?.orderInitialized === true,
      accountAllowlistCount: liveOrderDraft.accountAllowlist.count ?? 0,
    },
    event,
    nextSafeTask: allowedToSend
      ? "已開放真實單；下一步可由 operator-owned broker adapter 直接送單並監控成交回報。"
      : "真單格式模擬已隔離完成；下一步只產生 operator handoff 與 fresh quote/position 證據，仍不得啟用 broker write 或真單送出。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const report = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot });
  if (options.writeState || options.check) {
    await writeJsonWithSha(report.scope.statePath, report);
    await writeJsonWithSha(report.scope.tradingPath, report);
    await appendJsonLine(report.scope.quarantinePath, report.event);
  }
  if (options.check) {
    if (
      report.status !== "live_order_dry_run_pretrade_blocked" &&
      report.status !== "live_order_ready_to_send"
    ) {
      throw new Error(
        `CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_UNEXPECTED_STATUS status=${report.status}`,
      );
    }
    if (
      !isTrue(report.preTradeRiskGate.attachedBeforeBrokerSend) ||
      typeof report.preTradeRiskGate.allowedToSend !== "boolean"
    ) {
      throw new Error("CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_GATE_NOT_ATTACHED");
    }
    if (!isFalse(report.safety.sentOrder)) {
      throw new Error("CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_SAFETY_MISMATCH");
    }
    if (
      report.preTradeRiskGate.allowedToSend === true &&
      (!isTrue(report.safety.liveTradingEnabled) || !isTrue(report.safety.writeBrokerOrders))
    ) {
      throw new Error("CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_LIVE_ENABLE_MISMATCH");
    }
    if (
      report.preTradeRiskGate.allowedToSend === false &&
      !isTrue(report.safety.brokerCommandSuppressed)
    ) {
      throw new Error("CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_SUPPRESSION_MISMATCH");
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE=${report.status} api=${report.liveOrderDraft.brokerApi} symbol=${report.liveOrderDraft.commandPayload.stockNo} allowedToSend=${report.preTradeRiskGate.allowedToSend} sentOrder=${report.safety.sentOrder} blockers=${report.preTradeRiskGate.blockerCount}\n`,
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
