/**
 * trading-panel.ts — 交易操控面板
 *
 * 提供 Telegram 介面操控：
 * - 報價狀態查看（群益報價服務即時報價）
 * - Paper trading 模擬下單
 * - 策略監控與學習摘要
 * - 風控閘門狀態
 *
 * 安全規範：
 * - 預設 paper-only 模式
 * - 真實下單需要二次確認
 * - 不在訊息中傳送密碼/憑證
 */

import { buildBreadcrumb } from "./main-menu.js";
import { TRADING_BUTTON_COPY } from "./trading-copy.js";
import type { InteractiveReply } from "./types.js";

// ── 型別 ──────────────────────────────────────────────────────────

export type QuoteStatus = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  updatedAt: number;
  fresh: boolean;
};

export type PaperPosition = {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
};

export type TradingState = {
  mode: "paper" | "live";
  connected: boolean;
  quoteStatus: "fresh" | "stale" | "disconnected";
  positions: PaperPosition[];
  quotes: QuoteStatus[];
  blockers: string[];
  learningSummary?: string;
  auditSummary?: TradingFastOrderAuditSnapshotState | null;
  shortcutGateSummary?: TelegramTradingShortcutsSummaryState | null;
};

export type TelegramTradingShortcutsSummaryState = {
  generatedAt?: unknown;
  status?: unknown;
  summary?: unknown;
  failedChecks?: unknown;
};

export type OkxGateState = {
  generatedAt?: unknown;
  status?: unknown;
  markers?: unknown;
  blockers?: unknown;
  summary_zh_tw?: unknown;
  quote?: unknown;
  agentTradeKit?: unknown;
  authentication?: unknown;
  safety?: unknown;
  config?: unknown;
  credentialPolicy?: unknown;
  currentReadinessSummary?: unknown;
  currentReadinessRefreshWorkflow?: unknown;
  currentReadinessHeartbeatOperation?: unknown;
  marketSnapshotScheduler?: unknown;
  nextSafeTask?: unknown;
};

export type OkxOrderProposalGateState = {
  generatedAt?: unknown;
  mode?: unknown;
  code?: unknown;
  status?: unknown;
  summary_zh_tw?: unknown;
  blockers?: unknown;
  markers?: unknown;
  requestedOrder?: unknown;
  quoteContext?: unknown;
  preTradeChecks?: unknown;
  safety?: unknown;
  nextSafeTask?: unknown;
};

export type OkxOrderStatusGateState = {
  generatedAt?: unknown;
  mode?: unknown;
  code?: unknown;
  status?: unknown;
  summary_zh_tw?: unknown;
  blockers?: unknown;
  markers?: unknown;
  trackedOrder?: unknown;
  cancelStatus?: unknown;
  demoSimulation?: unknown;
  paperAuditSummary?: unknown;
  safety?: unknown;
  officialEndpointMap?: unknown;
  nextSafeTask?: unknown;
};

export type CapitalServiceStatusState = {
  generatedAt?: unknown;
  status?: unknown;
  ready?: unknown;
  blockerCode?: unknown;
  failedSteps?: unknown;
  capitalRoot?: unknown;
  readOnly?: unknown;
  loginAttempted?: unknown;
  service?: unknown;
  telegramPoller?: unknown;
  quote?: unknown;
  positionQuery?: unknown;
  paperTrading?: unknown;
  liveOrders?: unknown;
  watchdog?: unknown;
  orderMode?: unknown;
  safety?: unknown;
  nextSafeTask?: unknown;
  replyLine?: unknown;
};

export type CapitalPaperAssistantState = {
  generatedAt?: unknown;
  status?: unknown;
  ready?: unknown;
  readOnlyQuoteOnly?: unknown;
  loginAttempted?: unknown;
  liveTradingEnabled?: unknown;
  writeTradingEnabled?: unknown;
  brokerOrderPathEnabled?: unknown;
  badge?: unknown;
  assistant?: unknown;
  execution?: unknown;
  chartStrategy?: unknown;
  flowDecision?: unknown;
  fastOrderPaperPattern?: unknown;
  telegramPaperLoopLearningRefresh?: unknown;
  summary?: unknown;
  quote?: unknown;
  loop?: unknown;
  learning?: unknown;
  promotion?: unknown;
  cron?: unknown;
  tick?: unknown;
  recommendation?: unknown;
  shortcutGateSummary?: TelegramTradingShortcutsSummaryState | null;
};

export type CapitalDirectOperationState = {
  generatedAt?: unknown;
  status?: unknown;
  mode?: unknown;
  requestedTrade?: unknown;
  sealedIntentSha256?: unknown;
  templates?: unknown;
  activeTargets?: unknown;
  operatorSteps?: unknown;
  safety?: unknown;
  nextSafeTask?: unknown;
  statusReport?: unknown;
  inputsReport?: unknown;
  operatorPacketReport?: unknown;
  adapterAckGateReport?: unknown;
  localExecutorDispatchReport?: unknown;
  liveExecutorArmProfileReport?: unknown;
  autoDeactivateReceiptGateReport?: unknown;
  strategyPlatformReport?: unknown;
  adapterAckApplyVerifierReport?: unknown;
  adapterAckApplyPlanReport?: unknown;
  adapterAckApplyReceiptReport?: unknown;
  postApplyClosureReport?: unknown;
};

export type CapitalLocalExecutorDispatchState = {
  generatedAt?: unknown;
  status?: unknown;
  mode?: unknown;
  sealedIntentSha256?: unknown;
  dispatchPolicy?: unknown;
  machineLine?: unknown;
  operatorPacket?: unknown;
  executor?: unknown;
  dispatchContract?: unknown;
  blockers?: unknown;
  safety?: unknown;
  paths?: unknown;
  nextSafeTask?: unknown;
};

export type CapitalLiveExecutorArmProfileState = {
  generatedAt?: unknown;
  status?: unknown;
  mode?: unknown;
  executorId?: unknown;
  profileExists?: unknown;
  profileReadStatus?: unknown;
  armed?: unknown;
  allowExecutorWrite?: unknown;
  allowBrokerWriteWhenAllGatesPass?: unknown;
  allowConversationAgentDirectWrite?: unknown;
  brokerWriteAuthorityTarget?: unknown;
  operatorSignaturePresent?: unknown;
  armedAt?: unknown;
  expiresAt?: unknown;
  ttlSeconds?: unknown;
  maxTtlSeconds?: unknown;
  expired?: unknown;
  blockers?: unknown;
  requirements?: unknown;
  profileRequirementsObserved?: unknown;
  safety?: unknown;
  paths?: unknown;
  template?: unknown;
  operatorReview?: unknown;
  machineLine?: unknown;
  nextSafeTask?: unknown;
};

export type TradingSnapshotPanelState = {
  ts?: unknown;
  mode?: unknown;
  safety?: unknown;
  runtime?: unknown;
  platform?: unknown;
};

export type TradingFastOrderIntentWriteState = {
  generatedAt?: unknown;
  status?: unknown;
  intentId?: unknown;
  source?: unknown;
  mode?: unknown;
  ticket?: unknown;
  safety?: unknown;
  blockers?: unknown;
  brokerCommandEnabled?: unknown;
  submissionCommand?: unknown;
  sentBrokerOrder?: unknown;
  writeTargets?: unknown;
  errorDetail?: unknown;
  retryCommand?: unknown;
  nextSafeTask?: unknown;
};

export type TradingFastOrderIntentReviewState = {
  generatedAt?: unknown;
  status?: unknown;
  decision?: unknown;
  intentId?: unknown;
  source?: unknown;
  mode?: unknown;
  ticket?: unknown;
  paperExecution?: unknown;
  audit?: unknown;
  writeTargets?: unknown;
  nextSafeTask?: unknown;
};

export type TradingFastOrderAuditSnapshotState = {
  generatedAt?: unknown;
  status?: unknown;
  latestIntent?: unknown;
  latestReview?: unknown;
  latestPaperExecution?: unknown;
  fastOrderPaperPattern?: unknown;
  learningSnapshotRefresh?: unknown;
  safety?: unknown;
  readTargets?: unknown;
  history?: unknown;
  nextSafeTask?: unknown;
};

// ── 主交易面板 ────────────────────────────────────────────────────

export function buildTradingPanel(state: TradingState): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易");

  const modeIcon = state.mode === "paper" ? "📝" : "🔴";
  const modeText = state.mode === "paper" ? "模擬交易" : "實盤交易";
  const connIcon = state.connected ? "🟢" : "🔴";
  const connText = state.connected ? "已連線" : "未連線";
  const quoteIcon =
    state.quoteStatus === "fresh" ? "🟢" : state.quoteStatus === "stale" ? "🟡" : "🔴";
  const quoteText =
    state.quoteStatus === "fresh" ? "即時" : state.quoteStatus === "stale" ? "延遲" : "斷線";

  // 持倉摘要
  let positionText = "";
  if (state.positions.length > 0) {
    const totalPnl = state.positions.reduce((sum, p) => sum + p.pnl, 0);
    const pnlIcon = totalPnl >= 0 ? "📈" : "📉";
    positionText =
      `\n\n${pnlIcon} <b>持倉</b> (${state.positions.length})\n` +
      state.positions
        .slice(0, 5)
        .map((p) => {
          const sideIcon = p.side === "long" ? "🔺" : "🔻";
          const pnlSign = p.pnl >= 0 ? "+" : "";
          return `  ${sideIcon} ${escapeHtml(p.symbol)} ×${p.qty} | ${pnlSign}${p.pnl.toFixed(0)} (${pnlSign}${p.pnlPercent.toFixed(1)}%)`;
        })
        .join("\n") +
      `\n  合計損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}`;
  } else {
    positionText = "\n\n📋 目前無持倉";
  }

  // 報價摘要
  let quoteLines = "";
  if (state.quotes.length > 0) {
    quoteLines =
      "\n\n📊 <b>報價</b>\n" +
      state.quotes
        .slice(0, 6)
        .map((q) => {
          const chgIcon = q.change >= 0 ? "▲" : "▼";
          const chgSign = q.change >= 0 ? "+" : "";
          return `  ${escapeHtml(q.symbol)} ${q.price} ${chgIcon}${chgSign}${q.changePercent.toFixed(2)}%`;
        })
        .join("\n");
  }

  // 風控阻擋
  let blockerText = "";
  if (state.blockers.length > 0) {
    blockerText =
      "\n\n🚫 <b>風控阻擋</b>\n" + state.blockers.map((b) => `  ⚠️ ${escapeHtml(b)}`).join("\n");
  }

  const shortcutGateSummaryText = buildTelegramShortcutGateSummary(state.shortcutGateSummary);
  const auditSummaryText = buildTradingPanelAuditSummary(state.auditSummary);

  const text =
    `${nav}\n\n` +
    `${modeIcon} <b>${modeText}</b>\n` +
    `${connIcon} ${connText} | ${quoteIcon} 報價: ${quoteText}` +
    positionText +
    quoteLines +
    blockerText +
    shortcutGateSummaryText +
    auditSummaryText;

  const buttons: InteractiveReply["blocks"] = [
    { type: "text", text },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.quoteRefresh, value: "sc:tr:quote", style: "primary" },
        {
          label: TRADING_BUTTON_COPY.coreProductQuotes,
          value: "sc:tr:corequote",
          style: "primary",
        },
        { label: TRADING_BUTTON_COPY.positionDetail, value: "sc:tr:pos", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.aiPlatform, value: "sc:tr:platform", style: "success" },
        { label: TRADING_BUTTON_COPY.paperOrder, value: "sc:tr:paper", style: "success" },
        { label: TRADING_BUTTON_COPY.strategyStatus, value: "sc:tr:strat", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.paperReviewLoop, value: "sc:tr:paperloop", style: "success" },
        { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
        { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
        { label: TRADING_BUTTON_COPY.approvePaper, value: "sc:tr:approve", style: "success" },
        { label: TRADING_BUTTON_COPY.denyFastTicket, value: "sc:tr:deny", style: "danger" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
        { label: TRADING_BUTTON_COPY.learningSummary, value: "sc:tr:learn", style: "primary" },
        { label: TRADING_BUTTON_COPY.diagnose, value: "sc:tr:diag", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.capitalStatus, value: "sc:tr:cap", style: "primary" },
        { label: TRADING_BUTTON_COPY.hftGates, value: "sc:tr:hft", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.dispatcherCheck, value: "sc:tr:disp", style: "primary" },
        { label: TRADING_BUTTON_COPY.rerunChecks, value: "sc:tr:rerun", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.okxStatus, value: "sc:tr:okx", style: "primary" },
        {
          label: TRADING_BUTTON_COPY.okxReadinessRefresh,
          value: "sc:tr:okxrefresh",
          style: "primary",
        },
        { label: TRADING_BUTTON_COPY.okxOrderProposal, value: "sc:tr:okxord", style: "primary" },
        { label: TRADING_BUTTON_COPY.okxOrderStatus, value: "sc:tr:okxstat", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: TRADING_BUTTON_COPY.directOperate, value: "sc:tr:direct", style: "danger" },
        { label: TRADING_BUTTON_COPY.localExecutor, value: "sc:tr:localexec", style: "primary" },
        { label: TRADING_BUTTON_COPY.liveBlockers, value: "sc:tr:live", style: "danger" },
        { label: TRADING_BUTTON_COPY.receiptGate, value: "sc:tr:receipt", style: "primary" },
        { label: TRADING_BUTTON_COPY.paperAssistant, value: "sc:tr:assist", style: "success" },
      ],
    },
    {
      type: "buttons",
      buttons: [{ label: TRADING_BUTTON_COPY.home, value: "sc:home", style: "primary" }],
    },
  ];

  return { blocks: buttons };
}

function buildTelegramShortcutGateSummary(
  state: TelegramTradingShortcutsSummaryState | null | undefined,
): string {
  const gateState = asRecord(state);
  if (!gateState) {
    return "";
  }
  const summary = asRecord(gateState.summary);
  const assistantClosure = asRecord(summary?.assistantClosure);
  const paperLoopLearningRefresh = asRecord(assistantClosure?.paperLoopLearningRefresh);
  const assistantLearningHint = getAssistantLearningHintFromShortcutGate(state);
  const fixtureCoverage = asRecord(summary?.fixtureCoverage);
  const shortcutCheckCountClosure = asRecord(summary?.shortcutCheckCountClosure);
  const okxHeartbeatPublishTokenCountClosure = asRecord(
    summary?.okxHeartbeatPublishTokenCountClosure,
  );
  const quickLinks = stringList(assistantClosure?.quickLinks);
  const verifiedByChecks = stringList(assistantClosure?.quickLinksVerifiedByChecks);
  const fixtureCoverageTargets = stringList(fixtureCoverage?.targets);
  const paperLoopLearningRefreshText = paperLoopLearningRefresh
    ? `  paperLoop=${boolBadge(paperLoopLearningRefresh.visibleInPaperLoop)} assistant=${boolBadge(
        paperLoopLearningRefresh.visibleInAssistant,
      )} brokerLocked=${boolBadge(paperLoopLearningRefresh.brokerCommandLocked)}\n`
    : "";
  const assistantLearningHintText = formatAssistantLearningHint(assistantLearningHint, "compact");
  const shortcutNextCommandShortRow = buildAssistantNextCommandShortRow(state);
  const fixtureCoverageText = fixtureCoverage
    ? `  fixtureCoverage=<code>${escapeHtml(
        textValue(fixtureCoverage.status, "missing"),
      )}</code> targets=${formatInlineList(fixtureCoverageTargets)}\n`
    : "";
  const shortcutCheckCountText =
    typeof shortcutCheckCountClosure?.machineLine === "string" &&
    shortcutCheckCountClosure.machineLine.trim().length > 0
      ? `  checkCount=<code>${escapeHtml(shortcutCheckCountClosure.machineLine.trim())}</code>\n`
      : "";
  const okxHeartbeatPublishTokenCountText = okxHeartbeatPublishTokenCountClosure
    ? `  okxHeartbeatTokenCounts=<code>${escapeHtml(
        textValue(
          okxHeartbeatPublishTokenCountClosure.summaryZhTw,
          textValue(okxHeartbeatPublishTokenCountClosure.machineLine, "missing"),
        ),
      )}</code> noOrderWrite=${boolBadge(okxHeartbeatPublishTokenCountClosure.noOrderWrite)}\n`
    : "";

  return (
    `\n\n🧩 <b>Telegram 快捷 Gate</b>\n` +
    `  status=<code>${escapeHtml(textValue(gateState.status, "unknown"))}</code> checks=${formatUnknownNumber(
      summary?.checks,
    )} failed=${formatUnknownNumber(summary?.failed)}\n` +
    shortcutCheckCountText +
    okxHeartbeatPublishTokenCountText +
    `  assistantClosure=${boolBadge(
      assistantClosure?.quickLinksMatchPassedChecks,
    )} quickLinks=${formatInlineList(quickLinks)}\n` +
    `  verified=${formatInlineList(verifiedByChecks)} paperOnly=${boolBadge(
      assistantClosure?.paperOnlySafetyVisible,
    )}\n` +
    fixtureCoverageText +
    paperLoopLearningRefreshText +
    shortcutNextCommandShortRow +
    `\n` +
    assistantLearningHintText +
    `  updated=${escapeHtml(textValue(gateState.generatedAt, "無資料"))}`
  );
}

function formatShortcutGateStatusStrip(
  state: TelegramTradingShortcutsSummaryState | null | undefined,
): string {
  const gateState = asRecord(state);
  if (!gateState) {
    return "";
  }
  const summary = asRecord(gateState.summary);
  const fixtureCoverage = asRecord(summary?.fixtureCoverage);
  const shortcutCheckCountClosure = asRecord(summary?.shortcutCheckCountClosure);
  const okxPaperAuditClosure = asRecord(summary?.okxPaperAuditClosure);
  const okxCurrentReadinessClosure = asRecord(summary?.okxCurrentReadinessClosure);
  const okxCurrentReadinessRefreshWorkflowClosure = asRecord(
    summary?.okxCurrentReadinessRefreshWorkflowClosure,
  );
  const okxCurrentReadinessHeartbeatOperationClosure = asRecord(
    summary?.okxCurrentReadinessHeartbeatOperationClosure,
  );
  const okxHeartbeatPublishTokenCountClosure = asRecord(
    summary?.okxHeartbeatPublishTokenCountClosure,
  );
  const capitalHighConfidencePaperRerunClosure = asRecord(
    summary?.capitalHighConfidencePaperRerunClosure,
  );
  const capitalVerifiedPositionSnapshotClosure = asRecord(
    summary?.capitalVerifiedPositionSnapshotClosure,
  );
  const fixtureCoverageTargets = stringList(fixtureCoverage?.targets);
  const fixtureCoverageText = fixtureCoverage
    ? ` fixture=<code>${escapeHtml(textValue(fixtureCoverage.status, "missing"))}</code> targets=${formatInlineList(
        fixtureCoverageTargets,
      )}`
    : "";
  const shortcutCheckCountClosureText =
    typeof shortcutCheckCountClosure?.machineLine === "string" &&
    shortcutCheckCountClosure.machineLine.trim().length > 0
      ? `\n  checkCountClosure=<code>${escapeHtml(
          shortcutCheckCountClosure.machineLine.trim(),
        )}</code>`
      : "";
  const okxPaperAuditClosureText =
    typeof okxPaperAuditClosure?.machineLine === "string" &&
    okxPaperAuditClosure.machineLine.trim().length > 0
      ? `\n  okxPaperAuditClosure=<code>${escapeHtml(okxPaperAuditClosure.machineLine.trim())}</code>`
      : "";
  const okxCurrentReadinessClosureText =
    typeof okxCurrentReadinessClosure?.machineLine === "string" &&
    okxCurrentReadinessClosure.machineLine.trim().length > 0
      ? `\n  okxCurrentReadinessClosure=<code>${escapeHtml(
          okxCurrentReadinessClosure.machineLine.trim(),
        )}</code>`
      : "";
  const okxCurrentReadinessRefreshWorkflowClosureText =
    typeof okxCurrentReadinessRefreshWorkflowClosure?.machineLine === "string" &&
    okxCurrentReadinessRefreshWorkflowClosure.machineLine.trim().length > 0
      ? `\n  okxRefreshWorkflow=<code>${escapeHtml(
          okxCurrentReadinessRefreshWorkflowClosure.machineLine.trim(),
        )}</code>`
      : "";
  const okxCurrentReadinessRefreshWorkflowActionText = okxCurrentReadinessRefreshWorkflowClosure
    ? `\n  okxRefreshSteps=<code>${escapeHtml(
        textValue(okxCurrentReadinessRefreshWorkflowClosure.passedSteps, "未知"),
      )}/${escapeHtml(
        textValue(okxCurrentReadinessRefreshWorkflowClosure.totalSteps, "未知"),
      )}</code> failedSteps=${formatInlineList(
        stringList(okxCurrentReadinessRefreshWorkflowClosure.failedSteps),
      )} latestRefreshRun=<code>${escapeHtml(
        textValue(okxCurrentReadinessRefreshWorkflowClosure.latestRefreshRunStatus, "unknown"),
      )}/${escapeHtml(
        textValue(okxCurrentReadinessRefreshWorkflowClosure.latestRefreshRunExitCode, "null"),
      )}</code> noOrderWrite=${boolBadge(okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite)}`
    : "";
  const okxCurrentReadinessHeartbeatOperationClosureText =
    typeof okxCurrentReadinessHeartbeatOperationClosure?.machineLine === "string" &&
    okxCurrentReadinessHeartbeatOperationClosure.machineLine.trim().length > 0
      ? `\n  okxCurrentReadinessHeartbeatOperationClosure=<code>${escapeHtml(
          okxCurrentReadinessHeartbeatOperationClosure.machineLine.trim(),
        )}</code>`
      : "";
  const okxCurrentReadinessHeartbeatActionText = okxCurrentReadinessHeartbeatOperationClosure
    ? `\n  okxHeartbeatNext=<code>${escapeHtml(
        textValue(
          okxCurrentReadinessHeartbeatOperationClosure.nextSafeTask,
          "維持 OKX read-only heartbeat；必要時使用 sc:tr:okxrefresh。",
        ),
      )}</code>\n  okxHeartbeatRefresh=<code>${escapeHtml(
        textValue(
          okxCurrentReadinessHeartbeatOperationClosure.telegramCallback,
          "sc:tr:okxrefresh",
        ),
      )} / ${escapeHtml(
        textValue(
          okxCurrentReadinessHeartbeatOperationClosure.refreshCommand,
          "pnpm okx:current-readiness:refresh",
        ),
      )}</code> oneClick=${boolBadge(
        okxCurrentReadinessHeartbeatOperationClosure.oneClickRefresh,
      )} executeRequired=${boolBadge(
        okxCurrentReadinessHeartbeatOperationClosure.executeRequired,
      )} noOrderWrite=${boolBadge(
        okxCurrentReadinessHeartbeatOperationClosure.noOrderWrite,
      )}\n  okxHeartbeatSchedulerNextRunAt=<code>${escapeHtml(
        textValue(okxCurrentReadinessHeartbeatOperationClosure.schedulerNextRunAt, "unavailable"),
      )}</code>`
    : "";
  const okxCurrentReadinessHeartbeatInventoryText = okxCurrentReadinessHeartbeatOperationClosure
    ? `\n  okxHeartbeatInventory=<code>${escapeHtml(
        `${textValue(
          okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeStatus,
          "unknown",
        )} / ${textValue(
          okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeMachineLine,
          "missing",
        )}`,
      )}</code> ready=${boolBadge(
        okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeReady,
      )} noOrderWrite=${boolBadge(
        okxCurrentReadinessHeartbeatOperationClosure.inventoryProbeNoOrderWrite,
      )}`
    : "";
  const okxCurrentReadinessHeartbeatPublishBridgeText =
    okxCurrentReadinessHeartbeatOperationClosure &&
    typeof okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine === "string" &&
    okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.trim().length > 0
      ? `\n  okxHeartbeatPublishBridge=<code>${escapeHtml(
          okxCurrentReadinessHeartbeatOperationClosure.publishBridgeMachineLine.trim(),
        )}</code> ready=${boolBadge(
          okxCurrentReadinessHeartbeatOperationClosure.publishBridgeStatusReady,
        )} upstreamNoOrderWriteVerified=${boolBadge(
          okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteVerified,
        )} upstreamOkxContractVerified=${boolBadge(
          okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractVerified,
        )} upstreamDmadGateVerified=${boolBadge(
          okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateVerified,
        )} noOrderWriteCount=<code>${escapeHtml(
          textValue(okxCurrentReadinessHeartbeatOperationClosure.upstreamNoOrderWriteCount, "0"),
        )}</code> executeRequiredCount=<code>${escapeHtml(
          textValue(okxCurrentReadinessHeartbeatOperationClosure.upstreamExecuteRequiredCount, "0"),
        )}</code> okxContractCount=<code>${escapeHtml(
          textValue(okxCurrentReadinessHeartbeatOperationClosure.upstreamOkxContractCount, "0"),
        )}</code> dmadGateCount=<code>${escapeHtml(
          textValue(okxCurrentReadinessHeartbeatOperationClosure.upstreamDmadGateCount, "0"),
        )}</code>`
      : "";
  const okxHeartbeatPublishTokenCountText = okxHeartbeatPublishTokenCountClosure
    ? `\n  okxHeartbeatTokenCounts=<code>${escapeHtml(
        textValue(
          okxHeartbeatPublishTokenCountClosure.summaryZhTw,
          textValue(okxHeartbeatPublishTokenCountClosure.machineLine, "missing"),
        ),
      )}</code> noOrderWrite=${boolBadge(okxHeartbeatPublishTokenCountClosure.noOrderWrite)}`
    : "";
  const capitalHighConfidencePaperRerunText =
    typeof capitalHighConfidencePaperRerunClosure?.machineLine === "string" &&
    capitalHighConfidencePaperRerunClosure.machineLine.trim().length > 0
      ? `\n  capitalHighConfidence=<code>${escapeHtml(
          capitalHighConfidencePaperRerunClosure.machineLine.trim(),
        )}</code> requiredConfidenceStatus=<code>${escapeHtml(
          textValue(capitalHighConfidencePaperRerunClosure.requiredConfidenceStatus, "unknown"),
        )}</code> pass=<code>${escapeHtml(
          textValue(capitalHighConfidencePaperRerunClosure.passCount, "0"),
        )}</code> blocked=<code>${escapeHtml(
          textValue(capitalHighConfidencePaperRerunClosure.blockedCount, "0"),
        )}</code> noOrderWrite=${boolBadge(capitalHighConfidencePaperRerunClosure.noOrderWrite)}`
      : "";
  const capitalVerifiedPositionSnapshotText =
    typeof capitalVerifiedPositionSnapshotClosure?.machineLine === "string" &&
    capitalVerifiedPositionSnapshotClosure.machineLine.trim().length > 0
      ? `\n  capitalPosition=<code>${escapeHtml(
          capitalVerifiedPositionSnapshotClosure.machineLine.trim(),
        )}</code> positionFreshness=<code>${escapeHtml(
          textValue(capitalVerifiedPositionSnapshotClosure.freshnessStatus, "unknown"),
        )}</code> decision=<code>${escapeHtml(
          textValue(capitalVerifiedPositionSnapshotClosure.decisionStatus, "unknown"),
        )}</code> age=<code>${escapeHtml(
          textValue(capitalVerifiedPositionSnapshotClosure.verifiedAgeSeconds, "0"),
        )}/${escapeHtml(
          textValue(capitalVerifiedPositionSnapshotClosure.maxFreshSeconds, "0"),
        )}</code> noOrderWrite=${boolBadge(capitalVerifiedPositionSnapshotClosure.noOrderWrite)}`
      : "";
  return ` 快捷=<code>${escapeHtml(textValue(gateState.status, "unknown"))}/${formatUnknownNumber(
    summary?.checks,
  )}/${formatUnknownNumber(
    summary?.failed,
  )}</code>${fixtureCoverageText}${shortcutCheckCountClosureText}${okxHeartbeatPublishTokenCountText}${capitalHighConfidencePaperRerunText}${capitalVerifiedPositionSnapshotText}${okxPaperAuditClosureText}${okxCurrentReadinessClosureText}${okxCurrentReadinessRefreshWorkflowClosureText}${okxCurrentReadinessRefreshWorkflowActionText}${okxCurrentReadinessHeartbeatOperationClosureText}${okxCurrentReadinessHeartbeatActionText}${okxCurrentReadinessHeartbeatInventoryText}${okxCurrentReadinessHeartbeatPublishBridgeText}`;
}

function getAssistantLearningHintFromShortcutGate(
  state: TelegramTradingShortcutsSummaryState | null | undefined,
): Record<string, unknown> | null {
  const gateState = asRecord(state);
  if (!gateState) {
    return null;
  }
  const summary = asRecord(gateState.summary);
  const assistantClosure = asRecord(summary?.assistantClosure);
  return asRecord(assistantClosure?.assistantLearningHint);
}

function formatAssistantLearningHint(
  assistantLearningHint: Record<string, unknown> | null,
  mode: "compact" | "verified",
): string {
  if (!assistantLearningHint) {
    return "";
  }
  const quickLinks = stringList(assistantLearningHint.quickLinks);
  const verifiedByChecks = stringList(assistantLearningHint.quickLinksVerifiedByChecks);
  const nextSafeCommand = readAssistantNextCommand(
    assistantLearningHint,
    formatInlineList(quickLinks),
  );

  if (mode === "compact") {
    return `  learningHint=<code>${escapeHtml(nextSafeCommand)}</code> brokerLocked=${boolBadge(
      assistantLearningHint.brokerCommandLocked,
    )}\n`;
  }

  return (
    `\n  gateVerified=${boolBadge(readAssistantGateVerified(assistantLearningHint))} verified=${formatInlineList(verifiedByChecks)}\n` +
    `  gateHint=<code>${escapeHtml(
      nextSafeCommand,
    )}</code> note=${escapeHtml("下一步指令已由 gate 驗證")} brokerLocked=${boolBadge(
      assistantLearningHint.brokerCommandLocked,
    )}`
  );
}

function buildAssistantLearningHintVerifiedText(
  state: TelegramTradingShortcutsSummaryState | null | undefined,
): string {
  return formatAssistantLearningHint(getAssistantLearningHintFromShortcutGate(state), "verified");
}

function getAssistantNextCommandShortRow(
  assistantLearningHint: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(assistantLearningHint?.nextCommandShortRow);
}

function readAssistantNextCommand(
  assistantLearningHint: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  const nextCommandShortRow = getAssistantNextCommandShortRow(assistantLearningHint);
  return textValue(
    nextCommandShortRow?.command ?? assistantLearningHint?.nextSafeCommand,
    fallback,
  );
}

function readAssistantGateVerified(
  assistantLearningHint: Record<string, unknown> | null | undefined,
): unknown {
  const nextCommandShortRow = getAssistantNextCommandShortRow(assistantLearningHint);
  return nextCommandShortRow?.gateVerified ?? assistantLearningHint?.quickLinksMatchPassedChecks;
}

function buildTelegramPaperLoopCommandHint(
  refresh: Record<string, unknown> | null | undefined,
): string {
  if (!refresh) {
    return "";
  }
  const status = textValue(refresh.status, "unknown");
  const pattern = textValue(refresh.assistantFastOrderPaperPattern, "no-paper-execution");
  const submissionCommand = textValue(refresh.submissionCommand, "");
  const brokerLocked =
    refresh.brokerCommandEnabled === false &&
    refresh.sentBrokerOrder === false &&
    submissionCommand.length === 0;
  const nextSafeCommand =
    status === "refreshed" ? "sc:tr:learn / sc:tr:audit" : "sc:tr:assist / sc:tr:rerun";
  const commandHint =
    status === "refreshed"
      ? "先看學習摘要與審核紀錄；新的 fresh quote 後才重跑 sc:tr:paperloop。"
      : "先重新讀取助手狀態；維持 paper-only，不送實單。";

  return (
    `\n  nextSafeCommand=<code>${escapeHtml(nextSafeCommand)}</code> ` +
    `refresh=<code>${escapeHtml(status)}</code> pattern=<code>${escapeHtml(pattern)}</code>\n` +
    `  commandHint=${escapeHtml(commandHint)} brokerLocked=${boolBadge(brokerLocked)}`
  );
}

function buildAssistantLearningSummaryCommandHint(
  refresh: Record<string, unknown> | null | undefined,
  fastOrderPaperPattern: Record<string, unknown> | null | undefined,
  learning: Record<string, unknown> | null | undefined,
): string {
  if (!refresh && !fastOrderPaperPattern && !learning) {
    return "";
  }

  const submissionCommand = textValue(refresh?.submissionCommand, "");
  const brokerLocked =
    (refresh?.brokerCommandEnabled ?? false) === false &&
    (refresh?.sentBrokerOrder ?? false) === false &&
    submissionCommand.length === 0;
  const learningStatus = textValue(
    refresh?.status ?? fastOrderPaperPattern?.latestStatus ?? learning?.status,
    "unknown",
  );
  const pattern = textValue(
    refresh?.assistantFastOrderPaperPattern ?? fastOrderPaperPattern?.pattern,
    "no-paper-execution",
  );

  return (
    `\n` +
    `  learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>\n` +
    `  learning=<code>${escapeHtml(learningStatus)}</code> pattern=<code>${escapeHtml(
      pattern,
    )}</code>\n` +
    `  commandHint=${escapeHtml(
      "先看審核紀錄；新的 fresh quote 後才重跑 sc:tr:paperloop；回模擬助手確認安全鎖。",
    )} brokerLocked=${boolBadge(brokerLocked)}`
  );
}

function buildAssistantNextCommandShortRow(
  shortcutGateSummary: TelegramTradingShortcutsSummaryState | null | undefined,
): string {
  const assistantLearningHint = getAssistantLearningHintFromShortcutGate(shortcutGateSummary);
  const nextCommand = readAssistantNextCommand(
    assistantLearningHint,
    "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
  );
  const nextCommandShortRow = getAssistantNextCommandShortRow(assistantLearningHint);
  const nextCommandButtons = stringList(nextCommandShortRow?.buttons);
  const buttonText =
    nextCommandButtons.length > 0
      ? formatInlineList(nextCommandButtons)
      : "sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist";
  return `\n  nextCommandShortRow=<code>${escapeHtml(nextCommand)}</code> gateVerified=${boolBadge(
    readAssistantGateVerified(assistantLearningHint),
  )} buttons=<code>${buttonText}</code>`;
}

function formatRerunStatusStrip(
  state: CapitalPaperAssistantState,
  chartStrategy: Record<string, unknown> | null,
  simulation: Record<string, unknown> | null,
): string {
  return (
    `\n  重跑=<code>${escapeHtml(textValue(state.status, "unknown"))}/${escapeHtml(
      textValue(chartStrategy?.status, "unknown"),
    )}/${escapeHtml(textValue(simulation?.status, "unknown"))}</code> ` +
    `更新=<code>${escapeHtml(textValue(state.generatedAt, "無資料"))}</code>`
  );
}

function buildTradingPanelAuditSummary(
  state: TradingFastOrderAuditSnapshotState | null | undefined,
): string {
  const auditState = asRecord(state);
  if (!auditState) {
    return (
      `\n\n🧾 <b>快速進出場審核摘要</b>\n` +
      `  審核: 尚無資料\n` +
      `  模擬: 尚無紀錄\n` +
      `  歷史 總筆=0 回傳=0 篩選=<code>all</code>\n` +
      buildPaperExecutionLearningPattern(null) +
      `\n` +
      `  券商指令可用=❌ 已送券商單=❌ 送單指令=(empty)`
    );
  }

  const latestIntent = asRecord(auditState.latestIntent);
  const latestReview = asRecord(auditState.latestReview);
  const latestPaperExecution = asRecord(auditState.latestPaperExecution);
  const reviewAudit = asRecord(latestReview?.audit);
  const reviewPaper = asRecord(latestReview?.paperExecution);
  const safety = asRecord(auditState.safety);
  const history = asRecord(auditState.history);
  const intentBlockers = stringList(latestIntent?.blockers);
  const reviewBlockers = stringList(reviewAudit?.blockers);
  const reviewStatus = textValue(latestReview?.status, "unknown");
  const reviewDecision = textValue(latestReview?.decision, "unknown");
  const intentStatus = textValue(latestIntent?.status, "unknown");
  const paperStatus = textValue(latestPaperExecution?.status ?? latestReview?.status, "none");
  const brokerCommandEnabled =
    safety?.brokerCommandEnabled ??
    reviewAudit?.brokerCommandEnabled ??
    latestPaperExecution?.brokerCommandEnabled ??
    latestIntent?.brokerCommandEnabled ??
    false;
  const sentBrokerOrder =
    safety?.sentBrokerOrder ??
    reviewAudit?.sentBrokerOrder ??
    latestPaperExecution?.sentBrokerOrder ??
    latestIntent?.sentBrokerOrder ??
    false;
  const submissionCommand =
    textValue(safety?.submissionCommand ?? reviewAudit?.submissionCommand, "") || "(empty)";
  const blocked =
    reviewStatus === "denied" ||
    reviewDecision === "deny" ||
    intentStatus.includes("broker_locked") ||
    intentBlockers.length > 0 ||
    reviewBlockers.length > 0;
  const historyFilter = textValue(history?.filter, "all");
  const historyTotal = numericValue(history?.total, 0);
  const historyReturned = numericValue(history?.returned, 0);

  return (
    `\n\n🧾 <b>快速進出場審核摘要</b>\n` +
    `  審核: <code>${escapeHtml(reviewStatus)}</code> 決策=<code>${escapeHtml(
      reviewDecision,
    )}</code> 阻擋=${boolBadge(blocked)}\n` +
    `  意圖: <code>${escapeHtml(intentStatus)}</code>\n` +
    `  模擬: <code>${escapeHtml(paperStatus)}</code> 僅模擬=${boolBadge(
      latestPaperExecution?.paperOnly ?? reviewPaper?.paperOnly,
    )}\n` +
    `  歷史 總筆=${historyTotal} 回傳=${historyReturned} 篩選=<code>${escapeHtml(
      historyFilter,
    )}</code>\n` +
    buildPaperExecutionLearningPattern(auditState) +
    `\n` +
    `  券商指令可用=${boolBadge(brokerCommandEnabled)} 已送券商單=${boolBadge(
      sentBrokerOrder,
    )} 送單指令=${escapeHtml(submissionCommand)}`
  );
}

function buildPaperExecutionLearningPattern(
  state: TradingFastOrderAuditSnapshotState | Record<string, unknown> | null | undefined,
): string {
  const auditState = asRecord(state);
  if (!auditState) {
    return `  學習模式: 成功=0 失敗=0 最近=<code>none</code> 模式=<code>no-paper-execution</code>`;
  }

  const patternRecord =
    asRecord(auditState.fastOrderPaperPattern) ??
    (auditState.pattern !== undefined ||
    auditState.successCount !== undefined ||
    auditState.latestStatus !== undefined
      ? auditState
      : null);
  if (patternRecord) {
    const successCount = numericValue(patternRecord.successCount, 0);
    const failureCount = numericValue(patternRecord.failureCount, 0);
    const latestStatus = textValue(patternRecord.latestStatus, "none");
    const latestSymbol = textValue(patternRecord.latestSymbol, "TX00");
    const latestSide = textValue(patternRecord.latestSide, "wait");
    const latestQuantity = textValue(patternRecord.latestQuantity, "1");
    const pattern = textValue(patternRecord.pattern, "no-paper-execution");
    return (
      `  學習模式: 成功=${successCount} 失敗=${failureCount} 最近=<code>${escapeHtml(
        latestStatus,
      )}</code> ` +
      `${escapeHtml(latestSymbol)} ${escapeHtml(latestSide)} ×${escapeHtml(latestQuantity)} ` +
      `模式=<code>${escapeHtml(pattern)}</code>`
    );
  }

  const latestIntent = asRecord(auditState.latestIntent);
  const intentTicket = asRecord(latestIntent?.ticket);
  const latestReview = asRecord(auditState.latestReview);
  const latestPaperExecution = asRecord(auditState.latestPaperExecution);
  const reviewPaper = asRecord(latestReview?.paperExecution);
  const history = asRecord(auditState.history);
  const historyEntries = Array.isArray(history?.entries)
    ? history.entries
        .map(asRecord)
        .filter((record): record is Record<string, unknown> => record !== null)
    : [];
  const historySuccessCount = historyEntries.filter(isPaperSuccessEntry).length;
  const historyFailureCount = historyEntries.filter(isPaperFailureEntry).length;
  const latestReviewDecision = textValue(latestReview?.decision, "unknown");
  const latestReviewStatus = textValue(latestReview?.status, "unknown");
  const latestPaperSuccess =
    latestPaperExecution?.recorded === true ||
    latestPaperExecution?.paperOnly === true ||
    latestReviewDecision === "approve_paper" ||
    latestReviewStatus === "paper_execution_recorded";
  const latestPaperFailure = latestReviewDecision === "deny" || latestReviewStatus === "denied";
  const successCount = Math.max(historySuccessCount, latestPaperSuccess ? 1 : 0);
  const failureCount = Math.max(historyFailureCount, latestPaperFailure ? 1 : 0);
  const pattern =
    successCount > 0 && failureCount > 0
      ? "mixed-paper-pattern"
      : successCount > 0
        ? "paper-success"
        : failureCount > 0
          ? "paper-failure"
          : "no-paper-execution";
  const latestStatus = textValue(
    latestPaperExecution?.status ?? latestReview?.status,
    successCount > 0 ? "paper_execution_recorded" : "none",
  );
  const latestSymbol = textValue(
    latestPaperExecution?.symbol ?? reviewPaper?.symbol ?? intentTicket?.symbol,
    "TX00",
  );
  const latestSide = textValue(
    latestPaperExecution?.side ?? reviewPaper?.side ?? intentTicket?.side,
    "wait",
  );
  const latestQuantity = textValue(
    latestPaperExecution?.quantity ?? reviewPaper?.quantity ?? intentTicket?.quantity,
    "1",
  );

  return (
    `  學習模式: 成功=${successCount} 失敗=${failureCount} 最近=<code>${escapeHtml(
      latestStatus,
    )}</code> ` +
    `${escapeHtml(latestSymbol)} ${escapeHtml(latestSide)} ×${escapeHtml(latestQuantity)} ` +
    `模式=<code>${escapeHtml(pattern)}</code>`
  );
}

function isPaperSuccessEntry(entry: Record<string, unknown>): boolean {
  const kind = textValue(entry.kind, "");
  if (kind) {
    return kind === "paper_execution";
  }
  return (
    entry.recorded === true ||
    textValue(entry.status, "") === "paper_execution_recorded" ||
    textValue(entry.decision, "") === "approve_paper"
  );
}

function isPaperFailureEntry(entry: Record<string, unknown>): boolean {
  const kind = textValue(entry.kind, "");
  const decision = textValue(entry.decision, "");
  const status = textValue(entry.status, "");
  if (kind && kind !== "review") {
    return false;
  }
  return decision === "deny" || status === "denied";
}

// ── Paper Trading 下單確認面板 ──────────────────────────────────

export function buildPaperOrderPanel(): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "模擬下單");

  return {
    blocks: [
      {
        type: "text",
        text:
          `${nav}\n\n` +
          `📝 <b>模擬下單</b>\n\n` +
          `選擇操作或直接輸入指令：\n` +
          `<i>例：買 TX00 1口</i>\n` +
          `<i>例：賣 2330 5張</i>`,
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.buy, value: "sc:tr:buy", style: "success" },
          { label: TRADING_BUTTON_COPY.sell, value: "sc:tr:sell", style: "danger" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.closeAll, value: "sc:tr:closeall", style: "danger" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── 報價詳情面板 ──────────────────────────────────────────────────

type QuoteDetailPanelOptions = {
  quoteStatus?: TradingState["quoteStatus"];
  connected?: boolean;
};

function quoteStatusLabel(options: QuoteDetailPanelOptions): string {
  if (options.quoteStatus === "fresh") {
    return "即時";
  }
  if (options.quoteStatus === "stale") {
    return "延遲";
  }
  if (options.connected === true) {
    return "資料不足";
  }
  return "斷線";
}

export function buildQuoteDetailPanel(
  quotes: QuoteStatus[],
  options: QuoteDetailPanelOptions = {},
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "報價");

  if (quotes.length === 0) {
    const statusText = quoteStatusLabel(options);
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n📊 <b>報價</b>\n\n` +
            "目前沒有報價資料。\n" +
            `報價狀態：<b>${statusText}</b>\n\n` +
            "<i>可先點「交易診斷」檢查報價服務，再用模擬助手恢復循環。</i>",
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:quote", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.diagnose, value: "sc:tr:diag", style: "primary" },
            { label: TRADING_BUTTON_COPY.paperAssistant, value: "sc:tr:assist", style: "success" },
          ],
        },
      ],
    };
  }

  const lines = quotes.map((q) => {
    const freshIcon = q.fresh ? "🟢" : "🟡";
    const chgIcon = q.change >= 0 ? "▲" : "▼";
    const chgSign = q.change >= 0 ? "+" : "";
    const age = Math.round((Date.now() - q.updatedAt) / 1000);
    return (
      `${freshIcon} <b>${escapeHtml(q.symbol)}</b> ${escapeHtml(q.name)}\n` +
      `  ${q.price} ${chgIcon}${chgSign}${q.change} (${chgSign}${q.changePercent.toFixed(2)}%)\n` +
      `  量: ${q.volume.toLocaleString()} | ${age} 秒前`
    );
  });

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n📊 <b>即時報價</b>\n\n${lines.join("\n\n")}`,
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:quote", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── 策略狀態面板 ──────────────────────────────────────────────────

export type StrategyPanelState = {
  paperLoop: "running" | "stopped" | "blocked";
  blockReason?: string;
  lastSignal?: string;
  lastSignalAt?: number;
  winRate?: number;
  totalTrades?: number;
  chartStrategyStatus?: string;
  chartDataReady?: boolean;
  strategyBookReady?: boolean;
  strategyCount?: number;
  enabledStrategyCount?: number;
  simulationStatus?: string;
  simulationWinRate?: number;
  simulationPaperIntentCount?: number;
  fillSimulationStatus?: string;
  fillRecommendation?: string;
  fillTotalIntents?: number;
  fillFilledCount?: number;
  fillRate?: number;
  fillWinRate?: number;
  expectedValuePts?: number;
  monteCarloP05Pts?: number;
  monteCarloP50Pts?: number;
  monteCarloP95Pts?: number;
  monteCarloPositiveRate?: number;
  fillPaperOnly?: boolean;
  fillExecutionEligible?: boolean;
  fillPromotionBlocked?: boolean;
  quoteGateStatus?: string;
  quoteLatestStock?: string;
  quoteFreshnessAgeSeconds?: number;
  quoteMaxAllowedFreshAgeSeconds?: number;
  quoteReportableStatus?: string;
  quoteReportableCount?: number;
  quoteBlockedCount?: number;
  quoteBlockedCategory?: string;
  quoteBlockedReason?: string;
  quoteUnblockCondition?: string;
  quoteServiceAlive?: boolean;
  quoteRealtimeRunning?: boolean;
  quoteLatestCallbackAt?: string;
  learningStatus?: string;
  learningPaperEligible?: boolean;
  consecutiveReadinessBlocks?: number;
  latestQuoteAgeSeconds?: number;
  fullChainStatus?: string;
  fullChainStageFailedCount?: number;
  fullChainFaultFailedCount?: number;
  fullChainBlockers?: string[];
  livePromotionStatus?: string;
  livePromotionBlockerCode?: string;
  livePromotionBlockers?: string[];
  readyForManualReview?: boolean;
  realQuoteVerified?: boolean;
  brokerWriteLocked?: boolean;
  liveOrderAllowed?: boolean;
  nextSafeTask?: string;
};

export function buildStrategyPanel(
  state: StrategyPanelState,
  auditSummary?: TradingFastOrderAuditSnapshotState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "策略");

  const loopIcon =
    state.paperLoop === "running" ? "🟢" : state.paperLoop === "blocked" ? "🟡" : "🔴";
  const loopText =
    state.paperLoop === "running"
      ? "運行中"
      : state.paperLoop === "blocked"
        ? `阻擋: ${escapeHtml(state.blockReason ?? "未知")}`
        : "已停止";

  let statsText = "";
  if (state.totalTrades !== undefined) {
    statsText =
      `\n\n📊 <b>統計</b>\n` +
      `  交易次數: ${state.totalTrades}\n` +
      `  勝率: ${state.winRate !== undefined ? `${(state.winRate * 100).toFixed(1)}%` : "無資料"}`;
  }

  const safeSignalText = state.lastSignal
    ? `\n\n🔔 <b>最新訊號</b>\n  ${escapeHtml(state.lastSignal)}` +
      (state.lastSignalAt ? `\n  ${Math.round((Date.now() - state.lastSignalAt) / 1000)}s 前` : "")
    : "";

  const chartStrategyText =
    state.chartStrategyStatus ||
    state.chartDataReady !== undefined ||
    state.strategyBookReady !== undefined
      ? `\n\n📈 <b>圖表策略</b>\n` +
        `  狀態: <code>${escapeHtml(state.chartStrategyStatus ?? "unknown")}</code>\n` +
        `  圖表資料: ${boolBadge(state.chartDataReady)} | 策略書: ${boolBadge(
          state.strategyBookReady,
        )}\n` +
        `  策略: ${state.enabledStrategyCount ?? 0}/${state.strategyCount ?? 0} 已啟用\n` +
        `  模擬: <code>${escapeHtml(state.simulationStatus ?? "unknown")}</code>` +
        (state.simulationWinRate !== undefined
          ? ` | 勝率 ${(state.simulationWinRate * 100).toFixed(1)}%`
          : "") +
        (state.simulationPaperIntentCount !== undefined
          ? ` | 模擬意圖 ${state.simulationPaperIntentCount}`
          : "") +
        `\n  實單允許: ${boolBadge(state.liveOrderAllowed)} | Broker 寫入鎖: ${boolBadge(
          state.brokerWriteLocked,
        )} | 真報價驗證: ${boolBadge(state.realQuoteVerified)}`
      : "";

  const fillSimulationText =
    state.fillSimulationStatus ||
    state.fillRecommendation ||
    state.expectedValuePts !== undefined ||
    state.monteCarloP05Pts !== undefined
      ? `\n\n🧪 <b>成交模擬</b>\n` +
        `  狀態: <code>${escapeHtml(state.fillSimulationStatus ?? "unknown")}</code> | 建議: <code>${escapeHtml(
          state.fillRecommendation ?? "unknown",
        )}</code>\n` +
        `  成交: ${formatCount(state.fillFilledCount)}/${formatCount(
          state.fillTotalIntents,
        )} | 成交率 ${formatPercent(state.fillRate)} | 勝率 ${formatPercent(state.fillWinRate)}\n` +
        `  期望值: ${formatNumber(state.expectedValuePts)} pts | 蒙地卡羅 p05/p50/p95: ${formatNumber(
          state.monteCarloP05Pts,
        )}/${formatNumber(state.monteCarloP50Pts)}/${formatNumber(state.monteCarloP95Pts)} pts` +
        (state.monteCarloPositiveRate !== undefined
          ? ` | 正報酬 ${formatPercent(state.monteCarloPositiveRate)}`
          : "") +
        `\n  僅模擬: ${boolBadge(state.fillPaperOnly)} | 執行資格: ${boolBadge(
          state.fillExecutionEligible,
        )} | 升級阻擋: ${boolBadge(state.fillPromotionBlocked)}`
      : "";

  const blockerSnapshotText = hasBlockerSnapshot(state)
    ? `\n\n🚦 <b>即時阻擋</b>\n` +
      `  報價: <code>${escapeHtml(
        state.quoteGateStatus ?? state.quoteReportableStatus ?? "unknown",
      )}</code> ${escapeHtml(state.quoteLatestStock ?? "")} 時效 ${formatNumber(
        state.quoteFreshnessAgeSeconds,
      )}/${formatNumber(state.quoteMaxAllowedFreshAgeSeconds)}s\n` +
      `  回調: 服務 ${boolBadge(state.quoteServiceAlive)} | 即時 ${boolBadge(
        state.quoteRealtimeRunning,
      )} | 最新 ${escapeHtml(state.quoteLatestCallbackAt ?? "unknown")}\n` +
      `  可報價: ${formatCount(state.quoteReportableCount)} / 阻擋 ${formatCount(
        state.quoteBlockedCount,
      )} <code>${escapeHtml(state.quoteBlockedCategory ?? "無")}</code> 原因 <code>${escapeHtml(
        state.quoteBlockedReason ?? "無",
      )}</code>\n` +
      `  解鎖: ${escapeHtml(state.quoteUnblockCondition ?? "等待 fresh matched callback。")}\n` +
      `  學習: <code>${escapeHtml(state.learningStatus ?? "unknown")}</code> 模擬 ${boolBadge(
        state.learningPaperEligible,
      )} | 就緒阻擋 ${formatCount(
        state.consecutiveReadinessBlocks,
      )} | 報價時效 ${formatNumber(state.latestQuoteAgeSeconds)}s\n` +
      `  全鏈路: <code>${escapeHtml(state.fullChainStatus ?? "unknown")}</code> 階段/故障 ${formatCount(
        state.fullChainStageFailedCount,
      )}/${formatCount(state.fullChainFaultFailedCount)} | ${formatShortList(
        state.fullChainBlockers,
      )}\n` +
      `  實單閘門: <code>${escapeHtml(
        state.livePromotionStatus ?? "unknown",
      )}</code> 審核 ${boolBadge(state.readyForManualReview)} | <code>${escapeHtml(
        state.livePromotionBlockerCode ?? "無",
      )}</code> ${formatShortList(state.livePromotionBlockers)}`
    : "";

  const paperPatternText =
    `\n\n🧾 <b>快速進出場模擬模式</b>\n` +
    buildPaperExecutionLearningPattern(auditSummary) +
    `\n  brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)`;

  const nextSafeTaskText = state.nextSafeTask
    ? `\n\n➡️ <b>下一步</b>\n${escapeHtml(state.nextSafeTask)}`
    : "";

  return {
    blocks: [
      {
        type: "text",
        text:
          `${nav}\n\n` +
          `📈 <b>策略狀態</b>\n\n` +
          `${loopIcon} 模擬循環: ${loopText}` +
          statsText +
          safeSignalText +
          chartStrategyText +
          fillSimulationText +
          blockerSnapshotText +
          paperPatternText +
          nextSafeTaskText,
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.rerunChecks, value: "sc:tr:rerun", style: "success" },
          {
            label: TRADING_BUTTON_COPY.paperReviewLoop,
            value: "sc:tr:paperloop",
            style: "success",
          },
          { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:strat", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── AI 交易平台總覽 ────────────────────────────────────────────────

export function buildAiTradingPlatformPanel(
  snapshot: TradingSnapshotPanelState | null,
  auditSummary?: TradingFastOrderAuditSnapshotState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "AI 交易平台");
  const platform = asRecord(snapshot?.platform);

  if (!platform) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🧠 <b>AI 交易平台</b>\n\n` +
            `目前無法讀取 <code>trading.snapshot</code>。\n` +
            `請確認 Gateway 已啟動後再刷新。\n\n` +
            `🛡 brokerCommandEnabled=❌ submissionCommand=(empty)`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:platform", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const safety = asRecord(snapshot?.safety);
  const runtime = asRecord(snapshot?.runtime);
  const strategy = asRecord(platform.strategy);
  const ticket = asRecord(platform.fastOrderTicket);
  const okxLifecycle = asRecord(platform.okxLifecycle);
  const okxLifecycleBlockers = stringList(okxLifecycle?.blockers);
  const okxPaperAuditSummary = asRecord(platform.okxPaperAuditSummary);
  const okxPaperAuditSummaryBlockers = stringList(okxPaperAuditSummary?.blockers);
  const providers = Array.isArray(platform.providers)
    ? platform.providers
        .map(asRecord)
        .filter((record): record is Record<string, unknown> => record !== null)
    : [];
  const providerRows =
    providers.length > 0
      ? providers
          .map((provider) => {
            const blockers = stringList(provider.blockers);
            return (
              `  ${boolBadge(provider.ready)} <b>${escapeHtml(
                textValue(provider.label, textValue(provider.id, "券商")),
              )}</b> <code>${escapeHtml(
                localizeTradingStatusLabel(textValue(provider.status, "unknown")),
              )}</code>` +
              ` 阻擋=${escapeHtml(textValue(provider.blockerCount, String(blockers.length)))}\n` +
              `    ${escapeHtml(textValue(provider.summary, "無摘要"))}\n` +
              `    ${formatInlineBlockerList(blockers)}`
            );
          })
          .join("\n")
      : "  尚無券商閘門";
  const strategyText = strategy
    ? `  狀態: <code>${escapeHtml(
        localizeTradingStatusLabel(textValue(strategy.status, "unknown")),
      )}</code> ${escapeHtml(textValue(strategy.symbol, "TX00"))}/${escapeHtml(
        localizeTradingStatusLabel(textValue(strategy.quoteSymbol, "unknown")),
      )}\n` +
      `  訊號: ${escapeHtml(textValue(strategy.signalsGenerated, "0"))} | 意圖 ${escapeHtml(
        textValue(strategy.intentsReady, "0"),
      )} | 成交模擬 <code>${escapeHtml(
        localizeTradingStatusLabel(textValue(strategy.fillStatus, "unknown")),
      )}</code>\n` +
      `  建議: <code>${escapeHtml(
        localizeTradingStatusLabel(textValue(strategy.fillRecommendation, "觀望")),
      )}</code> | AI 模組 ${escapeHtml(textValue(strategy.aiModuleCount, "0"))} 就緒=${boolBadge(
        strategy.aiBrainReady,
      )}`
    : "  尚無策略狀態";
  const ticketBlockers = stringList(ticket?.blockers);
  const submissionCommand = textValue(ticket?.submissionCommand, "");
  const ticketStatus = textValue(ticket?.status, "");
  const ticketErrorDetail = summarizeUnknownMessage(ticket?.errorDetail, ticketStatus || "unknown");
  const ticketWriteFailureDiagnostics = resolveWriteFailureDiagnostics({
    status: ticketStatus,
    blockers: ticketBlockers,
    errorDetail: ticketErrorDetail,
  });
  const ticketFailureHintText = buildLiveBlockersWriteFailureHint({
    status: ticketStatus,
    submissionCommand,
    blockers: ticketBlockers,
    diagnostics: ticketWriteFailureDiagnostics,
  });
  const ticketText = ticket
    ? `  ${escapeHtml(textValue(ticket.provider, "capital"))} ${escapeHtml(
        textValue(ticket.symbol, "TX00"),
      )} ${escapeHtml(textValue(ticket.side, "wait"))} ×${escapeHtml(
        textValue(ticket.quantity, "1"),
      )}\n` +
      `  進場=${escapeHtml(textValue(ticket.entry, "wait"))} 出場=${escapeHtml(
        textValue(ticket.exit, "wait"),
      )}\n` +
      `  券商 API=<code>${escapeHtml(textValue(ticket.brokerApi, "unknown"))}</code>\n` +
      `  可執行=${boolBadge(ticket.executionAllowed)} 允許實單=${boolBadge(
        ticket.liveOrderAllowed,
      )}\n` +
      `  券商指令可用=${boolBadge(
        ticket.brokerCommandEnabled,
      )} 送單指令=${escapeHtml(submissionCommand || "(空白)")}\n` +
      `  阻擋=${escapeHtml(
        textValue(ticket.blockerCount, String(ticketBlockers.length)),
      )}: ${formatInlineBlockerList(ticketBlockers)}\n` +
      `  下一指令=<code>${escapeHtml(textValue(ticket.nextCommand, "capital-hft:capital:full-chain"))}</code>` +
      ticketFailureHintText
    : "  尚無快速下單票";
  const okxLifecycleText = okxLifecycle
    ? `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxLifecycle.status, "unknown")),
      )}</code> 代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxLifecycle.code, "unknown")),
      )}</code>\n` +
      `  模擬代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxLifecycle.simulationCode, "missing")),
      )}</code> 模擬狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxLifecycle.simulationStatus, "missing")),
      )}</code>\n` +
      `  模擬客戶單號=<code>${escapeHtml(
        textValue(okxLifecycle.simulatedClientOrderId, "無"),
      )}</code>\n` +
      `  已送單=${boolBadge(okxLifecycle.submittedOrder)} 交易所寫入嘗試=${boolBadge(
        okxLifecycle.exchangeWriteAttempted,
      )} 已送撤單=${boolBadge(okxLifecycle.cancelSubmitted)}\n` +
      `  阻擋=${formatInlineBlockerList(okxLifecycleBlockers)}\n` +
      `  報告=<code>${escapeHtml(textValue(okxLifecycle.reportPath, "unknown"))}</code>`
    : "  尚無 OKX 訂單狀態閘門";
  const okxPaperAuditSummaryText = okxPaperAuditSummary
    ? `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxPaperAuditSummary.status, "unknown")),
      )}</code> 代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxPaperAuditSummary.code, "unknown")),
      )}</code>\n` +
      `  筆數=${escapeHtml(textValue(okxPaperAuditSummary.totalEntries, "0"))} 全部安全=${boolBadge(
        okxPaperAuditSummary.allEntriesSafe,
      )}\n` +
      `  最新狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxPaperAuditSummary.latestStatus, "none")),
      )}</code> 最新代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(okxPaperAuditSummary.latestCode, "none")),
      )}</code>\n` +
      `  已送單=${escapeHtml(
        textValue(okxPaperAuditSummary.submittedOrderCount, "0"),
      )} 交易所寫入嘗試=${escapeHtml(
        textValue(okxPaperAuditSummary.exchangeWriteAttemptedCount, "0"),
      )} 訂單狀態查詢次數=${escapeHtml(
        textValue(okxPaperAuditSummary.orderStatusQueryExecutedCount, "0"),
      )} 已送撤單=${escapeHtml(textValue(okxPaperAuditSummary.cancelSubmittedCount, "0"))}\n` +
      `  阻擋=${formatInlineBlockerList(okxPaperAuditSummaryBlockers)}\n` +
      `  報告=<code>${escapeHtml(
        textValue(
          okxPaperAuditSummary.reportPath,
          "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
        ),
      )}</code>`
    : "  尚無 OKX 模擬稽核摘要閘門";
  const platformPaperPattern = asRecord(platform.fastOrderPaperPattern);
  const paperLearningText = buildPaperExecutionLearningPattern(
    auditSummary ?? (platformPaperPattern ? { fastOrderPaperPattern: platformPaperPattern } : null),
  );
  const text =
    `${nav}\n\n` +
    `🧠 <b>AI 交易平台</b>\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(platform.status, "not_configured")))}</code>\n` +
    `說明: ${escapeHtml(textValue(platform.title, "AI 交易平台需要狀態報告"))}\n` +
    `模式: <code>${escapeHtml(textValue(snapshot?.mode, "paper_only"))}</code> | 更新: ${escapeHtml(
      textValue(snapshot?.ts, "無資料"),
    )}\n\n` +
    `🛡 <b>執行閘門</b>\n` +
    `  實單=${boolBadge(safety?.liveTradingEnabled)} 寫入=${boolBadge(
      safety?.writesEnabled,
    )} 高風險=${boolBadge(safety?.highRiskEnabled)} 付費=${boolBadge(
      safety?.paidProviderEnabled,
    )}\n` +
    `  連線來源 ${escapeHtml(textValue(runtime?.connectedFeeds, "0"))}/${escapeHtml(
      textValue(runtime?.totalFeeds, "0"),
    )} | 執行中 ${escapeHtml(textValue(runtime?.runningFeeds, "0"))}\n\n` +
    `🏦 <b>券商閘門</b>\n${providerRows}\n\n` +
    `🟦 <b>OKX 生命週期</b>\n${okxLifecycleText}\n\n` +
    `🧾 <b>OKX 模擬稽核</b>\n${okxPaperAuditSummaryText}\n\n` +
    `📈 <b>策略引擎</b>\n${strategyText}\n\n` +
    `📚 <b>快速進出場學習</b>\n${paperLearningText}\n\n` +
    `⚡ <b>快速進出場票</b>\n${ticketText}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          {
            label: TRADING_BUTTON_COPY.paperReviewLoop,
            value: "sc:tr:paperloop",
            style: "success",
          },
          { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
          { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:platform", style: "primary" },
          { label: TRADING_BUTTON_COPY.strategyStatus, value: "sc:tr:strat", style: "primary" },
          { label: TRADING_BUTTON_COPY.liveBlockers, value: "sc:tr:live", style: "danger" },
        ],
      },
      {
        type: "buttons",
        buttons: [{ label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" }],
      },
    ],
  };
}

export function buildFastOrderIntentWritePanel(
  state: TradingFastOrderIntentWriteState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "寫入審核票");
  const stateStatus = textValue(state?.status, "");
  const writeFailed =
    state === null ||
    stateStatus === "gateway_unreachable" ||
    stateStatus === "gateway_timeout" ||
    stateStatus === "write_failed" ||
    stateStatus === "gateway_invalid_response";

  if (writeFailed) {
    const blockers = stringList(state?.blockers);
    const statusFallback =
      stateStatus === "gateway_invalid_response"
        ? "gateway_invalid_response_payload"
        : stateStatus === "gateway_timeout"
          ? "gateway_timeout"
          : stateStatus === "gateway_unreachable"
            ? "gateway_unreachable"
            : stateStatus === "write_failed"
              ? "write_failed"
              : stateStatus.length > 0
                ? `status:${stateStatus}`
                : "gateway_no_response";
    const errorDetail = summarizeUnknownMessage(state?.errorDetail, statusFallback);
    const writeFailureDiagnostics = resolveWriteFailureDiagnostics({
      status: stateStatus,
      blockers,
      errorDetail,
    });
    const retryCommand = textValue(state?.retryCommand, "sc:tr:write");
    const nextSafeTask = textValue(
      state?.nextSafeTask,
      "請先確認 Gateway 連線與 trading 方法可用，然後重試寫入審核票。",
    );
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `✍️ <b>快速進出場審核票</b>\n\n` +
            `寫入失敗或 Gateway 無回應。\n` +
            `status=<code>${escapeHtml(stateStatus || "unknown")}</code>\n` +
            `failureCode=<code>${escapeHtml(writeFailureDiagnostics.failureCode)}</code>\n` +
            `errorDetail=<code>${escapeHtml(errorDetail)}</code>\n` +
            `submissionCommandReason=<code>${escapeHtml(
              writeFailureDiagnostics.submissionCommandReason,
            )}</code>\n` +
            `retry=<code>${escapeHtml(retryCommand)}</code>\n` +
            `diagnose=<code>sc:tr:live / sc:tr:assist / sc:tr:write</code>\n` +
            `操作順序=<code>sc:tr:live → sc:tr:write → sc:tr:audit</code>\n` +
            `brokerCommandEnabled=❌ submissionCommand=(empty) sentBrokerOrder=❌\n` +
            `blockers=${formatInlineBlockerList(blockers)}\n` +
            `${writeFailureDiagnostics.actionHint}\n` +
            `nextSafeTask=${escapeHtml(nextSafeTask)}`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
            { label: TRADING_BUTTON_COPY.liveBlockers, value: "sc:tr:live", style: "danger" },
            { label: TRADING_BUTTON_COPY.paperAssistant, value: "sc:tr:assist", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const ticket = asRecord(state.ticket);
  const writeTargets = asRecord(state.writeTargets);
  const blockers = stringList(state.blockers);
  const ticketBlockers = stringList(ticket?.blockers);
  const submissionCommand = textValue(state.submissionCommand ?? ticket?.submissionCommand, "");
  const text =
    `${nav}\n\n` +
    `✍️ <b>快速進出場審核票已寫入</b>\n` +
    `狀態: <code>${escapeHtml(textValue(state.status, "unknown"))}</code>\n` +
    `intentId: <code>${escapeHtml(textValue(state.intentId, "unknown"))}</code>\n` +
    `來源: <code>${escapeHtml(textValue(state.source, "telegram.ai-platform"))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n\n` +
    `⚡ <b>票據</b>\n` +
    `  ${escapeHtml(textValue(ticket?.provider, "capital"))} ${escapeHtml(
      textValue(ticket?.symbol, "TX00"),
    )} ${escapeHtml(textValue(ticket?.side, "wait"))} ×${escapeHtml(
      textValue(ticket?.quantity, "1"),
    )}\n` +
    `  entry=${escapeHtml(textValue(ticket?.entry, "wait"))} exit=${escapeHtml(
      textValue(ticket?.exit, "wait"),
    )}\n` +
    `  brokerApi=<code>${escapeHtml(textValue(ticket?.brokerApi, "unknown"))}</code>\n` +
    `  executionAllowed=${boolBadge(ticket?.executionAllowed)} liveOrderAllowed=${boolBadge(
      ticket?.liveOrderAllowed,
    )}\n` +
    `  ticket blockers=${formatInlineBlockerList(ticketBlockers)}\n\n` +
    `🛡 <b>寫入安全證據</b>\n` +
    `  brokerCommandEnabled=${boolBadge(
      state.brokerCommandEnabled ?? ticket?.brokerCommandEnabled,
    )} submissionCommand=${escapeHtml(submissionCommand || "(empty)")}\n` +
    `  sentBrokerOrder=${boolBadge(state.sentBrokerOrder)} blockers=${formatInlineBlockerList(blockers)}\n` +
    `  jsonl=<code>${escapeHtml(textValue(writeTargets?.jsonl, "unknown"))}</code>\n` +
    `  report=<code>${escapeHtml(textValue(writeTargets?.latestReport, "unknown"))}</code>\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(
      textValue(
        state.nextSafeTask,
        "人工審核此 OpenClaw intent；所有 live gate 通過前不得送 broker order。",
      ),
    )}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.approvePaper, value: "sc:tr:approve", style: "success" },
          { label: TRADING_BUTTON_COPY.denyFastTicket, value: "sc:tr:deny", style: "danger" },
          { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "primary" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.aiPlatform, value: "sc:tr:platform", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

export function buildFastOrderIntentReviewPanel(
  state: TradingFastOrderIntentReviewState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "審核結果");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🧾 <b>快速進出場審核</b>\n\n` +
            `審核失敗或 Gateway 無回應。\n` +
            `brokerCommandEnabled=❌ submissionCommand=(empty) sentBrokerOrder=❌`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const ticket = asRecord(state.ticket);
  const paperExecution = asRecord(state.paperExecution);
  const audit = asRecord(state.audit);
  const writeTargets = asRecord(state.writeTargets);
  const blockers = stringList(audit?.blockers);
  const submissionCommand = textValue(
    audit?.submissionCommand ?? paperExecution?.submissionCommand ?? ticket?.submissionCommand,
    "",
  );
  const paperExecutionText = paperExecution
    ? `\n\n📝 <b>模擬執行</b>\n` +
      `  recorded=${boolBadge(paperExecution.recorded)} paperOnly=${boolBadge(
        paperExecution.paperOnly,
      )}\n` +
      `  ${escapeHtml(textValue(paperExecution.symbol, textValue(ticket?.symbol, "TX00")))} ${escapeHtml(
        textValue(paperExecution.side, textValue(ticket?.side, "wait")),
      )} ×${escapeHtml(textValue(paperExecution.quantity, textValue(ticket?.quantity, "1")))}\n` +
      `  entry=${escapeHtml(textValue(paperExecution.entry, textValue(ticket?.entry, "wait")))} exit=${escapeHtml(
        textValue(paperExecution.exit, textValue(ticket?.exit, "wait")),
      )}\n` +
      `  sentBrokerOrder=${boolBadge(paperExecution.sentBrokerOrder)}`
    : "";
  const text =
    `${nav}\n\n` +
    `🧾 <b>快速進出場審核結果</b>\n` +
    `狀態: <code>${escapeHtml(textValue(state.status, "unknown"))}</code>\n` +
    `decision: <code>${escapeHtml(textValue(state.decision, "unknown"))}</code>\n` +
    `intentId: <code>${escapeHtml(textValue(state.intentId, "unknown"))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}` +
    paperExecutionText +
    `\n\n🛡 <b>Audit</b>\n` +
    `  brokerCommandEnabled=${boolBadge(
      audit?.brokerCommandEnabled ??
        paperExecution?.brokerCommandEnabled ??
        ticket?.brokerCommandEnabled,
    )} submissionCommand=${escapeHtml(submissionCommand || "(empty)")}\n` +
    `  sentBrokerOrder=${boolBadge(
      audit?.sentBrokerOrder ?? paperExecution?.sentBrokerOrder,
    )} blockers=${formatInlineBlockerList(blockers)}\n` +
    `  reason=${escapeHtml(textValue(audit?.reason, "無"))}\n` +
    `  review=<code>${escapeHtml(textValue(writeTargets?.latestReview, "unknown"))}</code>\n` +
    `  paper=<code>${escapeHtml(textValue(writeTargets?.latestPaperExecution, "none"))}</code>\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(
      textValue(state.nextSafeTask, "檢查 audit；所有 live gate 通過前不得送 broker order。"),
    )}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
          { label: TRADING_BUTTON_COPY.aiPlatform, value: "sc:tr:platform", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

export function buildFastOrderAuditTrailPanel(
  state: TradingFastOrderAuditSnapshotState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "審核紀錄");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🧾 <b>快速進出場審核紀錄</b>\n\n` +
            `目前無法讀取審核紀錄。\n` +
            `brokerCommandEnabled=❌ submissionCommand=(empty) sentBrokerOrder=❌`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:audit", style: "primary" },
            {
              label: TRADING_BUTTON_COPY.paperReviewLoop,
              value: "sc:tr:paperloop",
              style: "success",
            },
            { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
            { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const latestIntent = asRecord(state.latestIntent);
  const latestReview = asRecord(state.latestReview);
  const latestPaperExecution = asRecord(state.latestPaperExecution);
  const intentTicket = asRecord(latestIntent?.ticket);
  const reviewAudit = asRecord(latestReview?.audit);
  const reviewPaper = asRecord(latestReview?.paperExecution);
  const safety = asRecord(state.safety);
  const readTargets = asRecord(state.readTargets);
  const learningSnapshotRefresh = asRecord(state.learningSnapshotRefresh);
  const history = asRecord(state.history);
  const historyEntries = Array.isArray(history?.entries)
    ? history.entries
        .map(asRecord)
        .filter((record): record is Record<string, unknown> => record !== null)
    : [];
  const historyFilter = textValue(history?.filter, "all");
  const historyOffset = numericValue(history?.offset, 0);
  const historyLimit = numericValue(history?.limit, 5);
  const historyTotal = numericValue(history?.total, historyEntries.length);
  const previousOffset = Math.max(0, historyOffset - historyLimit);
  const nextOffset = historyOffset + historyLimit;
  const reviewBlockers = stringList(reviewAudit?.blockers);
  const intentBlockers = stringList(latestIntent?.blockers);
  const paperPatternText =
    `\n\n🧾 <b>快速進出場模擬模式</b>\n` +
    buildPaperExecutionLearningPattern(state) +
    `\n  brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)`;
  const learningSnapshotText = learningSnapshotRefresh
    ? `\n\n📖 <b>學習快照</b>\n` +
      `  status=<code>${escapeHtml(textValue(learningSnapshotRefresh.status, "unknown"))}</code>\n` +
      `  pattern=<code>${escapeHtml(textValue(learningSnapshotRefresh.assistantFastOrderPaperPattern, "no-paper-execution"))}</code>\n` +
      `  brokerCommandEnabled=${boolBadge(
        learningSnapshotRefresh.brokerCommandEnabled,
      )} sentBrokerOrder=${boolBadge(
        learningSnapshotRefresh.sentBrokerOrder,
      )} submissionCommand=${escapeHtml(
        textValue(learningSnapshotRefresh.submissionCommand, "") || "(empty)",
      )}\n` +
      `  snapshot=<code>${escapeHtml(textValue(learningSnapshotRefresh.snapshotPath, "unknown"))}</code>`
    : "";

  const intentText = latestIntent
    ? `\n\n✍️ <b>最新審核票</b>\n` +
      `  status=<code>${escapeHtml(textValue(latestIntent.status, "unknown"))}</code>\n` +
      `  intentId=<code>${escapeHtml(textValue(latestIntent.intentId, "unknown"))}</code>\n` +
      `  ${escapeHtml(textValue(intentTicket?.provider, "capital"))} ${escapeHtml(
        textValue(intentTicket?.symbol, "TX00"),
      )} ${escapeHtml(textValue(intentTicket?.side, "wait"))} ×${escapeHtml(
        textValue(intentTicket?.quantity, "1"),
      )}\n` +
      `  blockers=${formatInlineBlockerList(intentBlockers)}\n` +
      `  sentBrokerOrder=${boolBadge(latestIntent.sentBrokerOrder)} brokerCommandEnabled=${boolBadge(
        latestIntent.brokerCommandEnabled,
      )}`
    : "\n\n✍️ <b>最新審核票</b>\n  尚無審核票";
  const reviewText = latestReview
    ? `\n\n🧾 <b>最新審核決策</b>\n` +
      `  status=<code>${escapeHtml(textValue(latestReview.status, "unknown"))}</code> decision=<code>${escapeHtml(
        textValue(latestReview.decision, "unknown"),
      )}</code>\n` +
      `  intentId=<code>${escapeHtml(textValue(latestReview.intentId, "unknown"))}</code>\n` +
      `  sentBrokerOrder=${boolBadge(reviewAudit?.sentBrokerOrder)} brokerCommandEnabled=${boolBadge(
        reviewAudit?.brokerCommandEnabled,
      )}\n` +
      `  submissionCommand=${escapeHtml(textValue(reviewAudit?.submissionCommand, "") || "(empty)")}\n` +
      `  blockers=${formatInlineBlockerList(reviewBlockers)}\n` +
      `  reason=${escapeHtml(textValue(reviewAudit?.reason, "無"))}`
    : "\n\n🧾 <b>最新審核決策</b>\n  尚無審核決策";
  const paperText =
    latestPaperExecution || reviewPaper
      ? `\n\n📝 <b>最新模擬執行</b>\n` +
        `  recorded=${boolBadge(
          latestPaperExecution?.recorded ?? reviewPaper?.recorded,
        )} paperOnly=${boolBadge(latestPaperExecution?.paperOnly ?? reviewPaper?.paperOnly)}\n` +
        `  ${escapeHtml(
          textValue(latestPaperExecution?.symbol ?? reviewPaper?.symbol, "TX00"),
        )} ${escapeHtml(textValue(latestPaperExecution?.side ?? reviewPaper?.side, "wait"))} ×${escapeHtml(
          textValue(latestPaperExecution?.quantity ?? reviewPaper?.quantity, "1"),
        )}\n` +
        `  sentBrokerOrder=${boolBadge(
          latestPaperExecution?.sentBrokerOrder ?? reviewPaper?.sentBrokerOrder,
        )} brokerCommandEnabled=${boolBadge(
          latestPaperExecution?.brokerCommandEnabled ?? reviewPaper?.brokerCommandEnabled,
        )}`
      : "\n\n📝 <b>最新模擬執行</b>\n  尚無模擬執行";
  const historyRows =
    historyEntries.length > 0
      ? historyEntries
          .map((entry, index) => {
            const number = historyOffset + index + 1;
            const kind = textValue(entry.kind, "unknown");
            const status = textValue(entry.status, "unknown");
            const decision = textValue(entry.decision, "");
            const symbol = textValue(entry.symbol, "TX00");
            const side = textValue(entry.side, "wait");
            const quantity = textValue(entry.quantity, "1");
            const generatedAt = textValue(entry.generatedAt, "no-time");
            const decisionText = decision ? ` decision=<code>${escapeHtml(decision)}</code>` : "";
            return (
              `  ${number}. <code>${escapeHtml(kind)}</code> ${escapeHtml(symbol)} ${escapeHtml(
                side,
              )} ×${escapeHtml(quantity)} ` +
              `<code>${escapeHtml(status)}</code>${decisionText}\n` +
              `     ${escapeHtml(generatedAt)} broker=${boolBadge(entry.sentBrokerOrder)} write=${boolBadge(
                entry.brokerCommandEnabled,
              )}`
            );
          })
          .join("\n")
      : "  尚無符合 filter 的歷史紀錄";
  const historyText =
    `\n\n📚 <b>最近審核 / 模擬歷史</b>\n` +
    `  filter=<code>${escapeHtml(historyFilter)}</code> offset=${historyOffset} limit=${historyLimit} total=${historyTotal}\n` +
    historyRows;
  const text =
    `${nav}\n\n` +
    `🧾 <b>快速進出場審核紀錄</b>\n` +
    `狀態: <code>${escapeHtml(textValue(state.status, "empty"))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `安全: sentBrokerOrder=${boolBadge(safety?.sentBrokerOrder)} brokerCommandEnabled=${boolBadge(
      safety?.brokerCommandEnabled,
    )} submissionCommand=${escapeHtml(textValue(safety?.submissionCommand, "") || "(empty)")}` +
    paperPatternText +
    learningSnapshotText +
    intentText +
    reviewText +
    paperText +
    historyText +
    `\n\n📁 <b>讀取來源</b>\n` +
    `  intent=<code>${escapeHtml(textValue(readTargets?.latestIntent, "unknown"))}</code>\n` +
    `  review=<code>${escapeHtml(textValue(readTargets?.latestReview, "unknown"))}</code>\n` +
    `  paper=<code>${escapeHtml(textValue(readTargets?.latestPaperExecution, "unknown"))}</code>\n` +
    `  history=<code>${escapeHtml(textValue(readTargets?.reviewsJsonl, "unknown"))}</code>\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(
      textValue(
        state.nextSafeTask,
        "依最新審核紀錄決定是否重新寫入審核票；所有 live gate 通過前不得送 broker order。",
      ),
    )}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          {
            label: TRADING_BUTTON_COPY.refresh,
            value: "sc:tr:audit",
            style: "primary",
          },
          {
            label: TRADING_BUTTON_COPY.paperReviewLoop,
            value: "sc:tr:paperloop",
            style: "success",
          },
          { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
          { label: TRADING_BUTTON_COPY.writeFastTicket, value: "sc:tr:write", style: "success" },
          { label: TRADING_BUTTON_COPY.aiPlatform, value: "sc:tr:platform", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "全部", value: "sc:tr:audit:all_0", style: "primary" },
          { label: "模擬單", value: "sc:tr:audit:paper_0", style: "success" },
          { label: "拒絕", value: "sc:tr:audit:denied_0", style: "danger" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            label: "上一頁",
            value: `sc:tr:audit:${historyFilter}_${previousOffset}`,
            style: "primary",
          },
          {
            label: "下一頁",
            value: `sc:tr:audit:${historyFilter}_${nextOffset}`,
            style: "primary",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [{ label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" }],
      },
    ],
  };
}

// ── 學習摘要面板 ──────────────────────────────────────────────────

export function buildLearningSummaryPanel(
  summary: string | null,
  auditSummary?: TradingFastOrderAuditSnapshotState | null,
  shortcutGateSummary?: TelegramTradingShortcutsSummaryState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "學習摘要");
  const paperPatternText =
    `\n\n🧾 <b>快速進出場模擬模式</b>\n` +
    buildPaperExecutionLearningPattern(auditSummary) +
    `\n  brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)`;
  const commandHintText = buildLearningSummaryCommandHint(auditSummary);
  const gateVerifiedText = buildAssistantLearningHintVerifiedText(shortcutGateSummary);
  const nextCommandShortRow = buildAssistantNextCommandShortRow(shortcutGateSummary);

  const text = summary
    ? `${nav}\n\n📖 <b>學習摘要</b>\n\n${escapeHtml(summary.slice(0, 2000))}${paperPatternText}${commandHintText}${nextCommandShortRow}${gateVerifiedText}`
    : `${nav}\n\n📖 <b>學習摘要</b>\n\n目前沒有學習記錄。\n\n<i>交易策略執行後會自動產生學習摘要。</i>${paperPatternText}${commandHintText}${nextCommandShortRow}${gateVerifiedText}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:learn", style: "primary" },
          {
            label: TRADING_BUTTON_COPY.paperReviewLoop,
            value: "sc:tr:paperloop",
            style: "success",
          },
          { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
          { label: TRADING_BUTTON_COPY.paperAssistant, value: "sc:tr:assist", style: "success" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

function buildLearningSummaryCommandHint(
  auditSummary: TradingFastOrderAuditSnapshotState | null | undefined,
): string {
  const auditState = asRecord(auditSummary);
  const refresh = asRecord(auditState?.learningSnapshotRefresh);
  const paperPattern = asRecord(auditState?.fastOrderPaperPattern);
  const latestReview = asRecord(auditState?.latestReview);
  const latestPaperExecution = asRecord(auditState?.latestPaperExecution);
  const safety = asRecord(auditState?.safety);
  const submissionCommand = textValue(
    safety?.submissionCommand ?? latestReview?.submissionCommand ?? refresh?.submissionCommand,
    "",
  );
  const brokerLocked =
    (safety?.brokerCommandEnabled ??
      latestPaperExecution?.brokerCommandEnabled ??
      refresh?.brokerCommandEnabled ??
      false) === false &&
    (safety?.sentBrokerOrder ??
      latestPaperExecution?.sentBrokerOrder ??
      refresh?.sentBrokerOrder ??
      false) === false &&
    submissionCommand.length === 0;
  const latestStatus = textValue(
    refresh?.status ?? paperPattern?.latestStatus ?? latestReview?.status,
    "unknown",
  );
  const pattern = textValue(
    refresh?.assistantFastOrderPaperPattern ?? paperPattern?.pattern,
    "no-paper-execution",
  );

  return (
    `\n\n➡️ <b>下一步指令</b>\n` +
    `  nextSafeCommand=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>\n` +
    `  learning=<code>${escapeHtml(latestStatus)}</code> pattern=<code>${escapeHtml(
      pattern,
    )}</code> brokerLocked=${boolBadge(brokerLocked)}\n` +
    `  commandHint=${escapeHtml(
      "先看審核紀錄；新的 fresh quote 後才重跑 sc:tr:paperloop；回模擬助手確認安全鎖。",
    )}`
  );
}

// ── 類高頻自動交易助手面板 ──────────────────────────────────────────

export function buildCapitalPaperAssistantPanel(
  state: CapitalPaperAssistantState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "模擬助手");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🤖 <b>類高頻自動交易助手</b>\n\n` +
            `目前沒有模擬助手狀態報告。\n\n` +
            `<i>請先執行 pnpm capital-hft:auto-trading-assistant:check，或重跑模擬閉環。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:assist", style: "primary" },
            { label: TRADING_BUTTON_COPY.rerunChecks, value: "sc:tr:rerun", style: "success" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const badge = asRecord(state.badge);
  const assistant = asRecord(state.assistant);
  const execution = asRecord(state.execution);
  const entry = asRecord(execution?.entry);
  const exit = asRecord(execution?.exit);
  const chartStrategy = asRecord(state.chartStrategy);
  const summary = asRecord(state.summary);
  const chartData = asRecord(chartStrategy?.chartData);
  const strategyBook = asRecord(chartStrategy?.strategyBook);
  const simulation = asRecord(chartStrategy?.simulation);
  const safety = asRecord(chartStrategy?.safety);
  const flowDecision = asRecord(state.flowDecision);
  const quote = asRecord(state.quote);
  const quoteDiagnostics = asRecord(quote?.diagnostics);
  const loop = asRecord(state.loop);
  const learning = asRecord(state.learning);
  const promotion = asRecord(state.promotion);
  const cron = asRecord(state.cron);
  const tick = asRecord(state.tick);
  const recommendation = asRecord(state.recommendation);
  const fastOrderPaperPattern =
    asRecord(state.fastOrderPaperPattern) ??
    asRecord(summary?.fastOrderPaperPattern) ??
    asRecord(learning?.fastOrderPaperPattern) ??
    asRecord(chartStrategy?.fastOrderPaperPattern);
  const telegramPaperLoopLearningRefresh = asRecord(state.telegramPaperLoopLearningRefresh);
  const quoteBlockers = stringList(quoteDiagnostics?.blockers);
  const gateText = formatAssistantGateRows(flowDecision?.gates);
  const nextSafeTask = textValue(
    recommendation?.nextSafeTask ??
      loop?.nextSafeTask ??
      learning?.nextSafeTask ??
      tick?.nextSafeTask,
    "等待新的 SKQuoteLib quote callback，再重跑 paper-only 檢查。",
  );
  const writeFailureAssist = buildAssistantWriteFailureAssistInfo(
    telegramPaperLoopLearningRefresh,
    fastOrderPaperPattern,
  );
  const statusStripText =
    `⚡ <b>快速狀態</b>\n` +
    `  學習=<code>${escapeHtml(textValue(learning?.status, "未知"))}</code> ` +
    `審核=<code>${escapeHtml(textValue(fastOrderPaperPattern?.latestStatus, "none"))}/${escapeHtml(
      textValue(fastOrderPaperPattern?.pattern, "no-paper-execution"),
    )} ${formatUnknownNumber(fastOrderPaperPattern?.successCount)}-${formatUnknownNumber(
      fastOrderPaperPattern?.failureCount,
    )}</code> ` +
    `閉環=<code>${escapeHtml(
      textValue(telegramPaperLoopLearningRefresh?.status ?? loop?.status, "未知"),
    )}</code>${writeFailureAssist.statusStrip}${formatShortcutGateStatusStrip(state.shortcutGateSummary)}` +
    (writeFailureAssist.actionHint.length > 0 ? `\n  ${writeFailureAssist.actionHint}` : "") +
    formatRerunStatusStrip(state, chartStrategy, simulation);
  const telegramPaperLoopRefreshText = telegramPaperLoopLearningRefresh
    ? `\n\n📡 <b>Telegram 模擬閉環</b>\n` +
      `  status=<code>${escapeHtml(textValue(telegramPaperLoopLearningRefresh.status, "unknown"))}</code>\n` +
      `  pattern=<code>${escapeHtml(
        textValue(
          telegramPaperLoopLearningRefresh.assistantFastOrderPaperPattern,
          "no-paper-execution",
        ),
      )}</code>\n` +
      `  brokerCommandEnabled=${boolBadge(
        telegramPaperLoopLearningRefresh.brokerCommandEnabled,
      )} sentBrokerOrder=${boolBadge(
        telegramPaperLoopLearningRefresh.sentBrokerOrder,
      )} submissionCommand=${escapeHtml(
        textValue(telegramPaperLoopLearningRefresh.submissionCommand, "") || "(empty)",
      )}\n` +
      `  snapshot=<code>${escapeHtml(textValue(telegramPaperLoopLearningRefresh.snapshotPath, "unknown"))}</code>`
    : "";
  const telegramPaperLoopCommandHintText = buildTelegramPaperLoopCommandHint(
    telegramPaperLoopLearningRefresh,
  );
  const assistantLearningCommandHintText = buildAssistantLearningSummaryCommandHint(
    telegramPaperLoopLearningRefresh,
    fastOrderPaperPattern,
    learning,
  );
  const assistantLearningHintVerifiedText = buildAssistantLearningHintVerifiedText(
    state.shortcutGateSummary,
  );
  const assistantNextCommandShortRow = buildAssistantNextCommandShortRow(state.shortcutGateSummary);

  const text =
    `${nav}\n\n` +
    `🤖 <b>${escapeHtml(textValue(assistant?.name, "類高頻自動交易助手"))}</b>\n\n` +
    `狀態: <code>${escapeHtml(textValue(state.status, "未知"))}</code> 就緒=${boolBadge(
      state.ready,
    )}\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `標籤: ${escapeHtml(textValue(badge?.label, "無"))}\n` +
    `說明: ${escapeHtml(textValue(assistant?.operatorAction ?? badge?.description, "無"))}\n\n` +
    statusStripText +
    `\n\n` +
    `🛡 <b>安全鎖</b>\n` +
    `  僅報價=${boolBadge(state.readOnlyQuoteOnly)} 登入=${boolBadge(
      state.loginAttempted,
    )} 實單=${boolBadge(state.liveTradingEnabled)}\n` +
    `  寫入=${boolBadge(state.writeTradingEnabled)} 券商路徑=${boolBadge(
      state.brokerOrderPathEnabled,
    )} Broker 寫入鎖=${boolBadge(safety?.brokerWriteLocked)}\n\n` +
    `🧭 <b>決策</b>\n` +
    `  代碼=<code>${escapeHtml(textValue(flowDecision?.decisionCode, "未知"))}</code> 動作=<code>${escapeHtml(
      textValue(flowDecision?.action, textValue(entry?.action, "未知")),
    )}</code>\n` +
    `  模擬循環=${boolBadge(flowDecision?.readyForPaperCycle)} 實單下單=${boolBadge(
      flowDecision?.liveOrderAllowed,
    )}\n\n` +
    `📊 <b>報價</b>\n` +
    `  <code>${escapeHtml(textValue(quote?.status, "未知"))}</code> ${escapeHtml(
      textValue(quote?.latestStock, "無標的"),
    )} 時效 ${formatUnknownNumber(quote?.freshnessAgeSeconds)}s 新鮮度 <code>${escapeHtml(
      textValue(quote?.freshnessStatus, "未知"),
    )}</code>\n` +
    `  阻擋: ${formatInlineBlockerList(quoteBlockers)}\n\n` +
    `🎯 <b>進出場</b>\n` +
    `  進場 ${escapeHtml(textValue(entry?.side, "buy"))}: <code>${escapeHtml(
      textValue(entry?.action, "未知"),
    )}</code> 就緒=${boolBadge(entry?.ready)} 價格=${formatUnknownNumber(entry?.price)}\n` +
    `  出場 ${escapeHtml(textValue(exit?.side, "sell"))}: <code>${escapeHtml(
      textValue(exit?.action, "未知"),
    )}</code> 就緒=${boolBadge(exit?.ready)} 價格=${formatUnknownNumber(exit?.price)}\n` +
    `  模擬意圖=${boolBadge(execution?.paperIntentCreated)}\n\n` +
    `📈 <b>圖表 / 策略 / 回測</b>\n` +
    `  chart_strategy=<code>${escapeHtml(textValue(chartStrategy?.status, "未知"))}</code> 圖表=${boolBadge(
      chartData?.ready,
    )} 策略書=${boolBadge(strategyBook?.ready)}\n` +
    `  策略 ${formatUnknownNumber(strategyBook?.enabledStrategyCount)}/${formatUnknownNumber(
      strategyBook?.strategyCount,
    )} | 模擬=<code>${escapeHtml(textValue(simulation?.status, "未知"))}</code> 模擬意圖 ${formatUnknownNumber(
      simulation?.paperIntentCount,
    )}\n` +
    `  實單允許=${boolBadge(safety?.liveOrderAllowed)} 真報價驗證=${boolBadge(
      simulation?.realQuoteVerified,
    )}\n\n` +
    `🚦 <b>閘門</b>\n${gateText}\n\n` +
    `📚 <b>學習 / 排程</b>\n` +
    `  循環=<code>${escapeHtml(textValue(loop?.status, "未知"))}</code> 學習=<code>${escapeHtml(
      textValue(learning?.status, "未知"),
    )}</code> 模擬=${boolBadge(learning?.paperEligible)} 實單=${boolBadge(learning?.liveEligible)}\n` +
    `  升級=<code>${escapeHtml(textValue(promotion?.status, "未知"))}</code> 排程=<code>${escapeHtml(
      textValue(cron?.status, "未知"),
    )}</code> 輪詢=<code>${escapeHtml(textValue(tick?.status, "未知"))}</code>\n\n` +
    `🧾 <b>快速進出場模擬模式</b>\n` +
    buildPaperExecutionLearningPattern(fastOrderPaperPattern) +
    `\n  brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)` +
    telegramPaperLoopRefreshText +
    `\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(nextSafeTask)}` +
    assistantNextCommandShortRow +
    telegramPaperLoopCommandHintText +
    assistantLearningCommandHintText +
    assistantLearningHintVerifiedText;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:assist", style: "primary" },
          { label: TRADING_BUTTON_COPY.rerunChecks, value: "sc:tr:rerun", style: "success" },
          { label: TRADING_BUTTON_COPY.learningSummary, value: "sc:tr:learn", style: "primary" },
          { label: TRADING_BUTTON_COPY.auditTrail, value: "sc:tr:audit", style: "primary" },
          {
            label: TRADING_BUTTON_COPY.paperReviewLoop,
            value: "sc:tr:paperloop",
            style: "success",
          },
          { label: TRADING_BUTTON_COPY.tradeAutoCycle, value: "sc:tr:auto", style: "success" },
          { label: TRADING_BUTTON_COPY.strategyStatus, value: "sc:tr:strat", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── 群益 API 狀態面板 ──────────────────────────────────────────────

export function buildCapitalServiceStatusPanel(
  state: CapitalServiceStatusState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "交易總覽");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🏦 <b>群益 API 狀態</b>\n\n` +
            `目前沒有群益服務狀態報告。\n\n` +
            `<i>請先執行 pnpm capital:service-status:check 產生最新狀態。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:cap", style: "primary" },
            {
              label: TRADING_BUTTON_COPY.coreProductQuotes,
              value: "sc:tr:corequote",
              style: "primary",
            },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const service = asRecord(state.service);
  const quote = asRecord(state.quote);
  const positionQuery = asRecord(state.positionQuery);
  const paperTrading = asRecord(state.paperTrading);
  const liveOrders = asRecord(state.liveOrders);
  const watchdog = asRecord(state.watchdog);
  const orderMode = asRecord(state.orderMode);
  const safety = asRecord(state.safety);
  const telegramPoller = asRecord(state.telegramPoller);
  const failedSteps = stringList(state.failedSteps);
  const failedText =
    failedSteps.length > 0
      ? failedSteps.map((item) => `  ⚠️ ${escapeHtml(item)}`).join("\n")
      : "  ✅ 無失敗步驟";

  const text =
    `${nav}\n\n` +
    `🏦 <b>群益 API 狀態</b>\n\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code> | 就緒: ${boolBadge(
      state.ready,
    )}\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `阻擋: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.blockerCode, "none")))}</code>\n` +
    `根目錄: <code>${escapeHtml(textValue(state.capitalRoot, "無資料"))}</code>\n\n` +
    `🖥 <b>服務</b>\n` +
    `  ${escapeHtml(localizeTradingStatusLabel(textValue(service?.status, "unknown")))}:${escapeHtml(
      localizeTradingStatusLabel(textValue(service?.livenessStatus, "unknown")),
    )}｜程序=${escapeHtml(textValue(service?.pid, "無資料"))}｜就緒=${boolBadge(service?.ready)}\n` +
    `  登入=<code>${escapeHtml(localizeTradingStatusLabel(textValue(service?.loginStatus, "unknown")))}</code> 報價監看=${boolBadge(
      service?.quoteMonitorConnected,
    )} 下單初始化=${boolBadge(service?.orderInitialized)}\n\n` +
    `📊 <b>報價</b>\n` +
    `  就緒=${boolBadge(quote?.ready)} 狀態=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(quote?.status ?? quote?.freshnessStatus, "unknown")),
    )}</code> 時效=${escapeHtml(textValue(quote?.freshnessAgeSeconds, "無資料"))}s\n` +
    `  callback可回報=${escapeHtml(textValue(quote?.callbackReportableCount, "0"))} fresh匹配=${escapeHtml(
      textValue(quote?.callbackFreshMatchedCount, "0"),
    )}\n\n` +
    `📋 <b>查詢 / 模擬</b>\n` +
    `  查詢=${boolBadge(positionQuery?.ready)} 帳戶數=${escapeHtml(
      textValue(positionQuery?.accountCount, "0"),
    )} | 模擬=${boolBadge(paperTrading?.ready)}\n` +
    `  下單模式=${boolBadge(orderMode?.ready)} <code>${escapeHtml(
      localizeTradingStatusLabel(textValue(orderMode?.status, "unknown")),
    )}</code>\n\n` +
    `🔴 <b>真單 / Watchdog</b>\n` +
    `  真單=${boolBadge(liveOrders?.ready)} 原因=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(liveOrders?.reason ?? liveOrders?.blocker, "unknown")),
    )}</code>\n` +
    `  watchdog=${boolBadge(watchdog?.ready)} 阻擋=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(watchdog?.blockerCode, "none")),
    )}</code>\n\n` +
    `🛡 <b>安全</b>\n` +
    `  唯讀=${boolBadge(state.readOnly)} | 已嘗試登入=${boolBadge(
      state.loginAttempted,
    )} | 已送單=${boolBadge(safety?.sentOrder)}\n` +
    `  允許Live=${boolBadge(safety?.allowLiveTrading)} | 可寫入券商=${boolBadge(
      safety?.writeBrokerOrders,
    )} | 真單允許=${boolBadge(safety?.realOrderAllowed)}\n\n` +
    `📨 <b>Telegram</b>\n` +
    `  ${escapeHtml(textValue(telegramPoller?.summary, "無資料"))}\n\n` +
    `🚫 <b>失敗步驟</b>\n${failedText}\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(textValue(state.nextSafeTask, "維持唯讀服務閘門。"))}\n\n` +
    `🧾 ${escapeHtml(textValue(state.replyLine, ""))}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:cap", style: "primary" },
          {
            label: TRADING_BUTTON_COPY.coreProductQuotes,
            value: "sc:tr:corequote",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.dispatcherCheck, value: "sc:tr:disp", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── 直接操作 Gate 面板 ─────────────────────────────────────────────

function formatCapitalLocalExecutorDispatchSection(
  state: CapitalLocalExecutorDispatchState,
): string {
  const operatorPacket = asRecord(state.operatorPacket);
  const executor = asRecord(state.executor);
  const dispatchContract = asRecord(state.dispatchContract);
  const commandPayload = asRecord(dispatchContract?.commandPayload);
  const sealedOrderIntent = asRecord(dispatchContract?.sealedOrderIntent);
  const safety = asRecord(state.safety);
  const paths = asRecord(state.paths);
  const blockers = stringList(state.blockers);
  const operatorBlockers = stringList(operatorPacket?.blockers);
  const noOrderWrite =
    safety?.noLiveOrderSent ??
    safety?.no_live_order_sent ??
    (safety?.writeBrokerOrders === false ? true : undefined);

  return (
    `🧩 <b>本地執行器 Dispatch</b>\n` +
    `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code> ` +
    `dispatch=<code>${escapeHtml(textValue(state.dispatchPolicy, "unknown"))}</code> ` +
    `operatorCanExecute=${boolBadge(operatorPacket?.operatorCanExecute)} executorArmed=${boolBadge(
      executor?.armed,
    )}\n` +
    `  sealedOrderIntent.sha256=<code>${escapeHtml(
      textValue(state.sealedIntentSha256 ?? sealedOrderIntent?.sha256, "missing"),
    )}</code>\n` +
    `  executor=<code>${escapeHtml(textValue(executor?.id, "missing"))}</code> arm=<code>${escapeHtml(
      textValue(executor?.armStatus, "unknown"),
    )}</code> credentialOwner=<code>${escapeHtml(
      textValue(executor?.credentialOwner, "missing"),
    )}</code>\n` +
    `  armProfile=<code>${escapeHtml(textValue(executor?.armProfilePath, "missing"))}</code>\n` +
    `  adapterAck=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(operatorPacket?.adapterAckStatus, "unknown")),
    )}</code> readiness=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(operatorPacket?.readinessStatus, "unknown")),
    )}</code> payloadHash=<code>${escapeHtml(
      textValue(dispatchContract?.payloadHash, "missing"),
    )}</code>\n` +
    `  order=<code>${escapeHtml(textValue(commandPayload?.stockNo, "missing"))}</code> side=<code>${escapeHtml(
      textValue(commandPayload?.buySell, "missing"),
    )}</code> qty=<code>${escapeHtml(textValue(commandPayload?.qty, "missing"))}</code> dayTrade=<code>${escapeHtml(
      textValue(commandPayload?.dayTradeMode, "unknown"),
    )}</code>\n` +
    `  noOrderWrite=${boolBadge(noOrderWrite)} sentOrder=${boolBadge(
      safety?.sentOrder,
    )} brokerApiCalled=${boolBadge(safety?.brokerApiCalled)} wroteBrokerCommand=${boolBadge(
      safety?.wroteBrokerCommand,
    )}\n` +
    `  machine=<code>${escapeHtml(textValue(state.machineLine, "missing"))}</code>\n` +
    `  blockers=${formatInlineBlockerList(blockers)}\n` +
    `  operatorBlockers=${formatInlineBlockerList(operatorBlockers)}\n` +
    `  report=<code>${escapeHtml(textValue(paths?.reportPath, "missing"))}</code>\n` +
    `  next=<code>${escapeHtml(
      textValue(state.nextSafeTask, "Keep local executor dispatch blocked until gates pass."),
    )}</code>`
  );
}

function formatCapitalLiveExecutorArmProfileSection(
  state: CapitalLiveExecutorArmProfileState,
): string {
  const requirements = asRecord(state.requirements);
  const observed = asRecord(state.profileRequirementsObserved);
  const safety = asRecord(state.safety);
  const paths = asRecord(state.paths);
  const template = asRecord(state.template);
  const operatorReview = asRecord(state.operatorReview);
  const rearmCandidate = asRecord(operatorReview?.rearmCandidate);
  const blockers = stringList(state.blockers);
  const allowExecutorWrite = state.allowExecutorWrite ?? state.allowBrokerWriteWhenAllGatesPass;
  const handoffChecklist = Array.isArray(operatorReview?.handoffChecklist)
    ? operatorReview.handoffChecklist
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 4)
    : [];
  const stagedRearmProfilePath =
    operatorReview?.stagedRearmProfilePath ?? paths?.stagedRearmProfilePath;
  const requirementKeys = [
    "killSwitch",
    "canaryRequired",
    "rollbackRequired",
    "freshQuoteRequired",
    "verifiedPositionRequired",
    "adapterAckHashRequired",
  ];
  const requirementText = requirementKeys
    .map(
      (key) =>
        `  - ${key}: required=${boolBadge(requirements?.[key])} observed=${boolBadge(
          observed?.[key],
        )}`,
    )
    .join("\n");
  const operatorReviewText = operatorReview
    ? `\n\n🧾 <b>Operator Rearm Handoff</b>\n` +
      `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(operatorReview.status, "unknown")))}</code> allowedWriter=<code>${escapeHtml(
        textValue(operatorReview.allowedWriter, "missing"),
      )}</code>\n` +
      `  active=<code>${escapeHtml(textValue(operatorReview.activeProfilePath ?? paths?.profilePath, "missing"))}</code>\n` +
      `  stagedRearm=<code>${escapeHtml(textValue(stagedRearmProfilePath, "missing"))}</code>\n` +
      `  activeProfileWriteSuppressed=${boolBadge(
        operatorReview.activeProfileWriteSuppressed,
      )} conversationMayWriteActiveProfile=${boolBadge(
        operatorReview.conversationAgentsMayWriteActiveProfile,
      )}\n` +
      `  candidateArmed=${boolBadge(rearmCandidate?.armed)} validation=<code>${escapeHtml(
        textValue(operatorReview.validationCommand, "missing"),
      )}</code>\n` +
      `  postRearm=<code>${escapeHtml(
        textValue(operatorReview.postRearmValidationCommand, "missing"),
      )}</code>\n` +
      (handoffChecklist.length > 0
        ? handoffChecklist
            .map(
              (item) =>
                `  - ${escapeHtml(textValue(item.id, "unknown"))}: <code>${escapeHtml(
                  localizeTradingStatusLabel(textValue(item.status, "unknown")),
                )}</code> validation=<code>${escapeHtml(
                  textValue(item.validationCommand, "missing"),
                )}</code>`,
            )
            .join("\n")
        : "  - 尚無 rearm handoff checklist")
    : "";

  return (
    `🔐 <b>Live Executor Arm Profile</b>\n` +
    `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code> ` +
    `armed=${boolBadge(state.armed)} allowExecutorWrite=${boolBadge(allowExecutorWrite)} ` +
    `expired=${boolBadge(state.expired)}\n` +
    `  executor=<code>${escapeHtml(textValue(state.executorId, "missing"))}</code> authority=<code>${escapeHtml(
      textValue(state.brokerWriteAuthorityTarget, "missing"),
    )}</code>\n` +
    `  profileExists=${boolBadge(state.profileExists)} read=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(state.profileReadStatus, "unknown")),
    )}</code> signature=${boolBadge(state.operatorSignaturePresent)} directConversationWrite=${boolBadge(
      state.allowConversationAgentDirectWrite,
    )}\n` +
    `  armedAt=<code>${escapeHtml(textValue(state.armedAt, "missing"))}</code> expiresAt=<code>${escapeHtml(
      textValue(state.expiresAt, "missing"),
    )}</code> ttl=${escapeHtml(textValue(state.ttlSeconds, "missing"))}/${escapeHtml(
      textValue(state.maxTtlSeconds, "missing"),
    )}s\n` +
    `  profile=<code>${escapeHtml(textValue(paths?.profilePath, "missing"))}</code>\n` +
    `  template=<code>${escapeHtml(textValue(paths?.templatePath, "missing"))}</code>\n` +
    `  stagedRearm=<code>${escapeHtml(textValue(stagedRearmProfilePath, "missing"))}</code>\n` +
    `  report=<code>${escapeHtml(textValue(paths?.reportPath, "missing"))}</code>\n` +
    `  template.note=<code>${escapeHtml(textValue(template?.note, "missing"))}</code>\n\n` +
    operatorReviewText +
    (operatorReviewText ? "\n\n" : "") +
    `🧷 <b>必要條件 observed flags</b>\n${requirementText}\n\n` +
    `🛡 <b>安全</b>\n` +
    `  noLiveOrderSent=${boolBadge(safety?.noLiveOrderSent)} sentOrder=${boolBadge(
      safety?.sentOrder,
    )} brokerWriteAttempted=${boolBadge(
      safety?.brokerWriteAttempted,
    )} conversationAgentDirectBrokerWrite=${boolBadge(
      safety?.conversationAgentDirectBrokerWrite,
    )} reportOnly=${boolBadge(safety?.reportOnly)}\n` +
    `  machine=<code>${escapeHtml(textValue(state.machineLine, "missing"))}</code>\n` +
    `  blockers=${formatInlineBlockerList(blockers)}\n` +
    `  command=<code>pnpm capital:trade:live-executor-profile:check</code>\n` +
    `  next=<code>${escapeHtml(
      textValue(
        state.nextSafeTask,
        "Fill and review the arm profile, then rerun live-executor-profile check.",
      ),
    )}</code>`
  );
}

export function buildCapitalLocalExecutorDispatchPanel(
  state: CapitalLocalExecutorDispatchState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "本地執行器");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🧩 <b>本地執行器 Dispatch</b>\n\n` +
            `尚無本地執行器 dispatch contract 報告。\n\n` +
            `<i>請先執行 pnpm capital:trade:direct:check 產生最新狀態；此面板只讀取 gate 結果，不送出真單。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:localexec", style: "primary" },
            { label: TRADING_BUTTON_COPY.directOperate, value: "sc:tr:direct", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n${formatCapitalLocalExecutorDispatchSection(state)}`,
      },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:localexec", style: "primary" },
          { label: TRADING_BUTTON_COPY.directOperate, value: "sc:tr:direct", style: "primary" },
          { label: TRADING_BUTTON_COPY.directRun, value: "sc:tr:directrun", style: "success" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

export function buildCapitalLiveExecutorArmProfilePanel(
  state: CapitalLiveExecutorArmProfileState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "實單 Arm");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🔐 <b>Live Executor Arm Profile</b>\n\n` +
            `尚無 live executor arm profile 報告。\n\n` +
            `<i>請先執行 pnpm capital:trade:live-executor-profile:check；此面板只讀取 gate 結果，不送出真單。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            {
              label: TRADING_BUTTON_COPY.refresh,
              value: "sc:tr:armprofile",
              style: "primary",
            },
            { label: TRADING_BUTTON_COPY.directOperate, value: "sc:tr:direct", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n${formatCapitalLiveExecutorArmProfileSection(state)}`,
      },
      {
        type: "buttons",
        buttons: [
          {
            label: TRADING_BUTTON_COPY.refresh,
            value: "sc:tr:armprofile",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.directOperate, value: "sc:tr:direct", style: "primary" },
          {
            label: TRADING_BUTTON_COPY.localExecutor,
            value: "sc:tr:localexec",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

export function buildCapitalDirectOperationPanel(
  state: CapitalDirectOperationState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "直接操作");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🚦 <b>直接操作 Gate</b>\n\n` +
            `目前沒有直接操作報告。\n\n` +
            `<i>請先執行 pnpm capital:trade:direct:check 產生 latest 狀態。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:direct", style: "primary" },
            {
              label: TRADING_BUTTON_COPY.coreProductQuotes,
              value: "sc:tr:corequote",
              style: "primary",
            },
            { label: TRADING_BUTTON_COPY.directRun, value: "sc:tr:directrun", style: "success" },
            {
              label: TRADING_BUTTON_COPY.directPositionRefresh,
              value: "sc:tr:directpos",
              style: "primary",
            },
            {
              label: TRADING_BUTTON_COPY.adapterApplyReceipt,
              value: "sc:tr:ackapply",
              style: "primary",
            },
            { label: TRADING_BUTTON_COPY.receiptGate, value: "sc:tr:receipt", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const statusReport = asRecord(state.statusReport);
  const inputsReport = asRecord(state.inputsReport) ?? asRecord(state);
  const summary = asRecord(statusReport?.summary);
  const quote = asRecord(summary?.quote);
  const requestedTrade =
    asRecord(inputsReport?.requestedTrade) ?? asRecord(summary?.requestedTrade);
  const position = asRecord(summary?.position);
  const adapter = asRecord(summary?.externalBrokerAdapter);
  const adapterApplyReceipt = asRecord(adapter?.applyReceipt);
  const adapterApplyReceiptHandoff = asRecord(adapterApplyReceipt?.operatorHandoff);
  const adapterApplyReceiptHandoffRequiredValidation = stringList(
    adapterApplyReceiptHandoff?.requiredValidation,
  ).slice(0, 3);
  const adapterApplyReceiptBlockers = stringList(adapterApplyReceipt?.blockers);
  const sealedIntent = asRecord(summary?.sealedOrderIntent);
  const activeTargets = asRecord(inputsReport?.activeTargets);
  const activePosition = asRecord(activeTargets?.verifiedPositionSnapshot);
  const activeAck = asRecord(activeTargets?.externalBrokerAdapterAck);
  const templates = asRecord(inputsReport?.templates);
  const positionTemplate = asRecord(templates?.verifiedPositionSnapshot);
  const ackTemplate = asRecord(templates?.externalBrokerAdapterAck);
  const ackRequiredCurrentTemplate = asRecord(templates?.externalBrokerAdapterAckRequiredCurrent);
  const inputOperatorReviews = asRecord(inputsReport?.operatorReviews);
  const positionHandoff = asRecord(position?.handoff);
  const positionRefreshReview = asRecord(inputOperatorReviews?.verifiedPositionSnapshotRefresh);
  const positionNextHandoffStep = asRecord(positionHandoff?.nextHandoffStep);
  const positionHandoffChecklist = Array.isArray(positionHandoff?.handoffChecklist)
    ? positionHandoff.handoffChecklist
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 4)
    : [];
  const positionStagedRefreshPath =
    positionHandoff?.stagedRefreshPath ??
    positionRefreshReview?.stagedRefreshPath ??
    activePosition?.stagedRefreshPath;
  const inputSafety = asRecord(inputsReport?.safety);
  const statusSafety = asRecord(summary?.safety);
  const operatorPacket = asRecord(state.operatorPacketReport);
  const localExecutorDispatch = asRecord(state.localExecutorDispatchReport);
  const operatorPacketLiveExecutorArmProfile = asRecord(operatorPacket?.liveExecutorArmProfile);
  const liveExecutorArmProfile =
    asRecord(state.liveExecutorArmProfileReport) ?? operatorPacketLiveExecutorArmProfile;
  const liveExecutorPaths = asRecord(liveExecutorArmProfile?.paths);
  const liveExecutorOperatorReview = asRecord(liveExecutorArmProfile?.operatorReview);
  const autoDeactivateReceiptGate = asRecord(state.autoDeactivateReceiptGateReport);
  const autoDeactivateReceiptSafety = asRecord(autoDeactivateReceiptGate?.safety);
  const autoDeactivateReceiptValidationCommands = asRecord(
    autoDeactivateReceiptGate?.validationCommands,
  );
  const autoDeactivateReceiptBlockers = stringList(autoDeactivateReceiptGate?.blockers);
  const operatorPacketSafety = asRecord(operatorPacket?.safety);
  const operatorPacketReadiness = asRecord(operatorPacket?.readiness);
  const operatorPacketAdapterAck = asRecord(operatorPacket?.adapterAck);
  const adapterAckGate = asRecord(state.adapterAckGateReport);
  const adapterAckOperatorReview = asRecord(adapterAckGate?.operatorReview);
  const adapterAckActiveVsCandidate = asRecord(adapterAckOperatorReview?.activeVsCandidate);
  const adapterAckRefreshPlan = asRecord(adapterAckOperatorReview?.refreshPlan);
  const adapterAckHandoffChecklist = Array.isArray(adapterAckOperatorReview?.handoffChecklist)
    ? adapterAckOperatorReview.handoffChecklist
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 5)
    : [];
  const operatorPacketExecution = asRecord(operatorPacket?.executionPayload);
  const operatorPacketBlockers = stringList(operatorPacket?.blockers);
  const operatorPacketBlockerPlan = asRecord(operatorPacket?.blockerPlan);
  const operatorPacketOrderedActions = Array.isArray(operatorPacketBlockerPlan?.orderedActions)
    ? operatorPacketBlockerPlan.orderedActions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 4)
    : [];
  const strategyPlatform = asRecord(state.strategyPlatformReport);
  const strategyReport = asRecord(strategyPlatform?.strategy);
  const strategyTailRiskRepair = asRecord(strategyReport?.strategyTailRiskRepair);
  const repairCandidatePlan = asRecord(strategyTailRiskRepair?.repairCandidatePlan);
  const nextPaperCandidateBatch = asRecord(repairCandidatePlan?.nextPaperCandidateBatch);
  const sameCaseRerunEvidence = asRecord(nextPaperCandidateBatch?.sameCaseRerunEvidence);
  const sameCaseRerunRankingLine = Array.isArray(
    sameCaseRerunEvidence?.candidateContributionRanking,
  )
    ? sameCaseRerunEvidence.candidateContributionRanking
        .map((candidate, index) => {
          const row = asRecord(candidate);
          const symbol = textValue(row?.symbol, "");
          if (!symbol) {
            return "";
          }
          return `${index + 1}:${symbol}:${textValue(row?.p05DragProxyNotional, "unknown")}`;
        })
        .filter((entry) => entry.length > 0)
        .slice(0, 3)
        .join("|")
    : "";
  const repairCandidateBuckets = Array.isArray(repairCandidatePlan?.buckets)
    ? repairCandidatePlan.buckets
        .map((bucket) => asRecord(bucket))
        .filter((bucket): bucket is Record<string, unknown> => bucket !== null)
        .slice(0, 6)
    : [];
  const liveCompletion = asRecord(strategyPlatform?.liveCompletion);
  const liveCompletionStages = Array.isArray(liveCompletion?.stages)
    ? liveCompletion.stages
        .map((stage) => asRecord(stage))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const blockers = stringList(summary?.blockers);
  const operatorSteps = Array.isArray(inputsReport?.operatorSteps)
    ? inputsReport.operatorSteps
        .map((step) => asRecord(step))
        .filter((step): step is Record<string, unknown> => step !== null)
    : [];
  const operatorStepText =
    operatorSteps.length > 0
      ? operatorSteps
          .slice(0, 3)
          .map(
            (step) =>
              `  - ${escapeHtml(textValue(step.id, "unknown"))}: <code>${escapeHtml(
                textValue(step.validation, "unknown"),
              )}</code>`,
          )
          .join("\n")
      : "  - 尚無 operator steps";
  const sealedHash =
    textValue(inputsReport?.sealedIntentSha256, "") || textValue(sealedIntent?.sha256, "missing");
  const positionFreshnessStatus = textValue(
    activePosition?.freshnessStatus ?? position?.freshnessStatus,
    "unknown",
  );
  const positionGateReady =
    (activePosition?.usable ?? position?.usable) === true && positionFreshnessStatus === "fresh";
  const adapterAckStatus = textValue(
    adapter?.ackStatus ?? operatorPacketAdapterAck?.status,
    "unknown",
  );
  const adapterAckHashOk = operatorPacketAdapterAck?.hashOk ?? activeAck?.hashOk;
  const adapterAckReady =
    (activeAck?.usable ?? adapter?.ackUsable) === true && adapterAckHashOk === true;
  const liveExecutorProfilePath =
    liveExecutorArmProfile?.profilePath ?? liveExecutorPaths?.profilePath;
  const liveExecutorTemplatePath =
    liveExecutorArmProfile?.templatePath ?? liveExecutorPaths?.templatePath;
  const liveExecutorAllowWrite =
    liveExecutorArmProfile?.allowExecutorWrite ??
    liveExecutorArmProfile?.allowBrokerWriteWhenAllGatesPass;
  const liveExecutorReady =
    liveExecutorArmProfile?.armed === true && liveExecutorAllowWrite === true;
  const liveExecutorBlockers = stringList(liveExecutorArmProfile?.blockers);
  const liveExecutorStagedRearmProfilePath =
    liveExecutorOperatorReview?.stagedRearmProfilePath ?? liveExecutorPaths?.stagedRearmProfilePath;
  const liveExecutorHandoffChecklist = Array.isArray(liveExecutorOperatorReview?.handoffChecklist)
    ? liveExecutorOperatorReview.handoffChecklist
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 3)
    : [];
  const liveExecutorHandoffText = liveExecutorOperatorReview
    ? `  rearmHandoff=<code>${escapeHtml(localizeTradingStatusLabel(textValue(liveExecutorOperatorReview.status, "unknown")))}</code> stagedRearm=<code>${escapeHtml(
        textValue(liveExecutorStagedRearmProfilePath, "missing"),
      )}</code> allowedWriter=<code>${escapeHtml(
        textValue(liveExecutorOperatorReview.allowedWriter, "missing"),
      )}</code>\n` +
      `  activeProfileWriteSuppressed=${boolBadge(
        liveExecutorOperatorReview.activeProfileWriteSuppressed,
      )} conversationMayWriteActiveProfile=${boolBadge(
        liveExecutorOperatorReview.conversationAgentsMayWriteActiveProfile,
      )}\n` +
      (liveExecutorHandoffChecklist.length > 0
        ? liveExecutorHandoffChecklist
            .map(
              (item) =>
                `  - ${escapeHtml(textValue(item.id, "unknown"))}: <code>${escapeHtml(
                  localizeTradingStatusLabel(textValue(item.status, "unknown")),
                )}</code>`,
            )
            .join("\n") + "\n"
        : "  - 尚無 live executor rearm handoff checklist\n")
    : "";
  const liveUnlockChecklistText =
    `🔐 <b>真單解鎖三件事</b>\n` +
    `  1. verified position snapshot=${boolBadge(positionGateReady)} freshness=<code>${escapeHtml(
      localizeTradingStatusLabel(positionFreshnessStatus),
    )}</code> age=${escapeHtml(
      textValue(activePosition?.verifiedAgeSeconds ?? position?.verifiedAgeSeconds, "無資料"),
    )}/${escapeHtml(
      textValue(activePosition?.maxFreshSeconds ?? position?.maxFreshSeconds, "無資料"),
    )} path=<code>${escapeHtml(textValue(activePosition?.path ?? position?.path, "missing"))}</code>\n` +
    `  2. adapter ack required-current=${boolBadge(adapterAckReady)} ack=<code>${escapeHtml(
      localizeTradingStatusLabel(adapterAckStatus),
    )}</code> hashOk=${boolBadge(adapterAckHashOk)} requiredCurrent=<code>${escapeHtml(
      textValue(
        ackRequiredCurrentTemplate?.path ?? operatorPacketAdapterAck?.requiredTemplatePath,
        "missing",
      ),
    )}</code>\n` +
    `  3. live executor arm profile=${boolBadge(liveExecutorReady)} status=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(liveExecutorArmProfile?.status, "unknown")),
    )}</code> armed=${boolBadge(liveExecutorArmProfile?.armed)} allowExecutorWrite=${boolBadge(
      liveExecutorAllowWrite,
    )} expired=${boolBadge(liveExecutorArmProfile?.expired)} armProfile=<code>${escapeHtml(
      textValue(liveExecutorProfilePath, "missing"),
    )}</code>\n` +
    `  template=<code>${escapeHtml(textValue(liveExecutorTemplatePath, "missing"))}</code> blockers=${formatInlineBlockerList(
      liveExecutorBlockers,
    )}\n` +
    liveExecutorHandoffText +
    `\n`;
  const adapterCanaryNoOrder =
    operatorPacketAdapterAck?.canarySentOrder === true
      ? false
      : operatorPacketAdapterAck?.canarySentOrder === false
        ? true
        : undefined;
  const positionHandoffText =
    positionHandoff || positionRefreshReview
      ? `  handoff=<code>${escapeHtml(
          localizeTradingStatusLabel(
            textValue(
              positionHandoff?.status ?? positionRefreshReview?.operatorReviewStatus,
              "unknown",
            ),
          ),
        )}</code> next=<code>${escapeHtml(
          textValue(positionNextHandoffStep?.id, "review_current_broker_position"),
        )}</code>\n` +
        `  stagedRefresh=<code>${escapeHtml(textValue(positionStagedRefreshPath, "missing"))}</code>\n` +
        (positionHandoffChecklist.length > 0
          ? positionHandoffChecklist
              .map(
                (item) =>
                  `  - ${escapeHtml(textValue(item.id, "unknown"))}: <code>${escapeHtml(
                    localizeTradingStatusLabel(textValue(item.status, "unknown")),
                  )}</code>`,
              )
              .join("\n") + "\n"
          : "  - 尚無 position handoff checklist\n")
      : "";
  const adapterAckHandoffText = adapterAckGate
    ? `  handoff=<code>${escapeHtml(localizeTradingStatusLabel(textValue(adapterAckOperatorReview?.status, "unknown")))}</code> activeVsCandidate=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(adapterAckActiveVsCandidate?.status, "unknown")),
      )}</code>\n` +
      `  stagedCandidate=<code>${escapeHtml(
        textValue(adapterAckOperatorReview?.stagedCandidateAckPath, "missing"),
      )}</code>\n` +
      (adapterAckRefreshPlan
        ? `  refreshPlan=<code>${escapeHtml(
            localizeTradingStatusLabel(textValue(adapterAckRefreshPlan.status, "unknown")),
          )}</code> safeToPromote=${boolBadge(
            adapterAckRefreshPlan.safeToPromoteCandidate,
          )} source=<code>${escapeHtml(
            textValue(adapterAckRefreshPlan.sourcePath, "missing"),
          )}</code> dest=<code>${escapeHtml(
            textValue(adapterAckRefreshPlan.destinationPath, "missing"),
          )}</code>\n`
        : "") +
      (adapterAckHandoffChecklist.length > 0
        ? adapterAckHandoffChecklist
            .map(
              (item) =>
                `  - ${escapeHtml(textValue(item.id, "unknown"))}: <code>${escapeHtml(
                  localizeTradingStatusLabel(textValue(item.status, "unknown")),
                )}</code>`,
            )
            .join("\n") + "\n"
        : "  - 尚無 adapter ack handoff checklist\n")
    : "";
  const adapterAckApplyVerifier = asRecord(state.adapterAckApplyVerifierReport);
  const adapterAckApplyVerdict = asRecord(adapterAckApplyVerifier?.applyVerdict);
  const adapterAckApplyPlan = asRecord(state.adapterAckApplyPlanReport);
  const adapterAckOperatorApplyPlan = asRecord(adapterAckApplyPlan?.operatorApplyPlan);
  const adapterAckApplyReceiptGate = asRecord(state.adapterAckApplyReceiptReport);
  const adapterAckOperatorReceipt = asRecord(adapterAckApplyReceiptGate?.operatorReceipt);
  const postApplyClosure = asRecord(state.postApplyClosureReport);
  const postApplyClosureAdapterApply = asRecord(postApplyClosure?.adapterApply);
  const postApplyClosureApplyPlan = asRecord(postApplyClosure?.applyPlan);
  const postApplyClosureReceipt = asRecord(postApplyClosure?.adapterApplyReceipt);
  const postApplyClosureLiveReadiness = asRecord(postApplyClosure?.liveReadiness);
  const postApplyClosureLocalExecutor = asRecord(postApplyClosure?.localExecutorDispatch);
  const postApplyClosureSafety = asRecord(postApplyClosure?.safety);
  const postApplyClosureValidationCommands = asRecord(postApplyClosure?.validationCommands);
  const adapterAckReceiptValidationCommands = asRecord(
    adapterAckOperatorReceipt?.validationCommands,
  );
  const postApplyClosureBlockers = stringList(postApplyClosure?.blockers).slice(0, 8);
  const adapterPostApplyReportsPresent =
    adapterAckApplyVerifier ||
    adapterAckApplyPlan ||
    adapterAckApplyReceiptGate ||
    postApplyClosure;
  const adapterPostApplySourcePath =
    postApplyClosureReceipt?.sourcePath ??
    adapterAckOperatorReceipt?.sourcePath ??
    adapterAckOperatorApplyPlan?.sourcePath ??
    adapterAckApplyVerdict?.sourcePath;
  const adapterPostApplyDestinationPath =
    postApplyClosureReceipt?.destinationPath ??
    adapterAckOperatorReceipt?.destinationPath ??
    adapterAckOperatorApplyPlan?.destinationPath ??
    adapterAckApplyVerdict?.destinationPath;
  const adapterPostApplyReadbackText = adapterPostApplyReportsPresent
    ? `📌 <b>Adapter Post-Apply Readback</b>\n` +
      `  verifier=<code>${escapeHtml(
        localizeTradingStatusLabel(
          textValue(
            adapterAckApplyVerifier?.status ??
              adapterAckApplyVerdict?.status ??
              postApplyClosureAdapterApply?.verifierStatus,
            "unknown",
          ),
        ),
      )}</code> activeState=<code>${escapeHtml(
        localizeTradingStatusLabel(
          textValue(
            adapterAckApplyVerdict?.activeState ?? postApplyClosureAdapterApply?.activeState,
            "unknown",
          ),
        ),
      )}</code> operatorMayApply=${boolBadge(
        adapterAckApplyVerdict?.operatorMayApply ?? postApplyClosureAdapterApply?.operatorMayApply,
      )} operatorApplyVerified=${boolBadge(
        adapterAckApplyVerdict?.operatorApplyVerified ??
          postApplyClosureAdapterApply?.operatorApplyVerified,
      )}\n` +
      `  plan=<code>${escapeHtml(
        localizeTradingStatusLabel(
          textValue(
            adapterAckApplyPlan?.status ??
              adapterAckOperatorApplyPlan?.status ??
              postApplyClosureApplyPlan?.status,
            "unknown",
          ),
        ),
      )}</code> applyAllowedByPlan=${boolBadge(
        adapterAckOperatorApplyPlan?.applyAllowedByPlan ??
          postApplyClosureApplyPlan?.applyAllowedByPlan,
      )} alreadyApplied=${boolBadge(
        adapterAckOperatorApplyPlan?.alreadyAppliedVerified ??
          postApplyClosureApplyPlan?.alreadyAppliedVerified,
      )}\n` +
      `  receipt=<code>${escapeHtml(
        localizeTradingStatusLabel(
          textValue(
            adapterAckApplyReceiptGate?.status ??
              adapterAckOperatorReceipt?.status ??
              postApplyClosureReceipt?.status,
            "unknown",
          ),
        ),
      )}</code> verified=${boolBadge(
        postApplyClosureReceipt?.verified ?? adapterAckOperatorReceipt?.operatorApplyVerified,
      )} action=<code>${escapeHtml(
        textValue(adapterAckOperatorReceipt?.action ?? postApplyClosureReceipt?.action, "missing"),
      )}</code>\n` +
      `  closure=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(postApplyClosure?.status, "unknown")),
      )}</code> operatorCanExecute=${boolBadge(
        postApplyClosure?.operatorCanExecute ?? postApplyClosureLiveReadiness?.operatorCanExecute,
      )} liveReadiness=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(postApplyClosureLiveReadiness?.status, "unknown")),
      )}</code> localDispatch=<code>${escapeHtml(
        textValue(postApplyClosureLocalExecutor?.status, "unknown"),
      )}</code>\n` +
      `  source=<code>${escapeHtml(textValue(adapterPostApplySourcePath, "missing"))}</code>\n` +
      `  dest=<code>${escapeHtml(textValue(adapterPostApplyDestinationPath, "missing"))}</code>\n` +
      `  receiptCheck=<code>${escapeHtml(
        textValue(
          postApplyClosureValidationCommands?.applyReceipt ??
            adapterAckReceiptValidationCommands?.receipt,
          "pnpm capital:trade:adapter-ack-apply-receipt:check",
        ),
      )}</code>\n` +
      `  postApply=<code>${escapeHtml(
        textValue(
          postApplyClosureValidationCommands?.closure ??
            adapterAckReceiptValidationCommands?.postApplyClosure,
          "pnpm capital:trade:post-apply-closure:check",
        ),
      )}</code>\n` +
      `  noLiveOrderSent=${boolBadge(postApplyClosureSafety?.noLiveOrderSent)} sentOrder=${boolBadge(
        postApplyClosureSafety?.sentOrder,
      )} writeBrokerOrders=${boolBadge(postApplyClosureSafety?.writeBrokerOrders)}\n` +
      `  machine=<code>${escapeHtml(textValue(postApplyClosure?.machineLine, "missing"))}</code>\n` +
      `  blockers=${formatInlineBlockerList(postApplyClosureBlockers)}\n\n`
    : "";
  const adapterApplyReceiptText = adapterApplyReceipt
    ? `📥 <b>Adapter Apply Receipt</b>\n` +
      `  status=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(adapterApplyReceipt.status, "unknown")),
      )}</code> verified=${boolBadge(adapterApplyReceipt.verified)} operatorMayApply=${boolBadge(
        adapterApplyReceipt.operatorMayApply,
      )} operatorApplyVerified=${boolBadge(adapterApplyReceipt.operatorApplyVerified)}\n` +
      `  action=<code>${escapeHtml(textValue(adapterApplyReceipt.action, "missing"))}</code> owner=<code>${escapeHtml(
        textValue(adapterApplyReceipt.owner, "missing"),
      )}</code> activeState=<code>${escapeHtml(
        textValue(adapterApplyReceipt.activeState, "missing"),
      )}</code>\n` +
      (adapterApplyReceiptHandoff
        ? `  handoffNext=<code>${escapeHtml(
            textValue(adapterApplyReceiptHandoff.nextAction, "missing"),
          )}</code> allowedActor=<code>${escapeHtml(
            textValue(adapterApplyReceiptHandoff.allowedActor, "missing"),
          )}</code>\n` +
          `  automationMayWriteActiveAck=${boolBadge(
            adapterApplyReceiptHandoff.automationMayWriteActiveAck,
          )} telegramMayWriteActiveAck=${boolBadge(
            adapterApplyReceiptHandoff.telegramMayWriteActiveAck,
          )} brokerOrderWriteAllowed=${boolBadge(
            adapterApplyReceiptHandoff.brokerOrderWriteAllowed,
          )}\n` +
          `  handoffValidation=${formatInlineBlockerList(
            adapterApplyReceiptHandoffRequiredValidation,
          )}\n`
        : "") +
      `  source=<code>${escapeHtml(textValue(adapterApplyReceipt.sourcePath, "missing"))}</code>\n` +
      `  dest=<code>${escapeHtml(textValue(adapterApplyReceipt.destinationPath, "missing"))}</code>\n` +
      `  validation=<code>${escapeHtml(
        textValue(
          adapterApplyReceipt.validationCommand,
          "pnpm capital:trade:adapter-ack-apply-receipt:check",
        ),
      )}</code>\n` +
      `  postApply=<code>${escapeHtml(
        textValue(
          adapterApplyReceipt.postApplyClosureCommand,
          "pnpm capital:trade:post-apply-closure:check",
        ),
      )}</code>\n` +
      `  noLiveOrderSent=${boolBadge(adapterApplyReceipt.noLiveOrderSent)} sentOrder=${boolBadge(
        adapterApplyReceipt.sentOrder,
      )} writeBrokerOrders=${boolBadge(
        adapterApplyReceipt.writeBrokerOrders,
      )} liveTradingEnabled=${boolBadge(adapterApplyReceipt.liveTradingEnabled)}\n` +
      `  machine=<code>${escapeHtml(textValue(adapterApplyReceipt.machineLine, "missing"))}</code>\n` +
      `  blockers=${formatInlineBlockerList(adapterApplyReceiptBlockers)}\n` +
      `  next=<code>${escapeHtml(textValue(adapterApplyReceipt.nextSafeTask, "missing"))}</code>\n\n`
    : "";
  const operatorPacketBlockerPlanText = operatorPacketBlockerPlan
    ? `  nextAction=<code>${escapeHtml(
        textValue(operatorPacketBlockerPlan?.nextAction, "unknown"),
      )}</code> ordered=${escapeHtml(
        textValue(
          operatorPacketBlockerPlan?.orderedActionCount ?? operatorPacketOrderedActions.length,
          "0",
        ),
      )}\n` +
      (operatorPacketOrderedActions.length > 0
        ? operatorPacketOrderedActions
            .map(
              (item) =>
                `  - ${escapeHtml(textValue(item.id, "unknown"))}: <code>${escapeHtml(
                  localizeTradingStatusLabel(textValue(item.status, "unknown")),
                )}</code> gate=<code>${escapeHtml(textValue(item.gate, "unknown"))}</code> validate=<code>${escapeHtml(
                  textValue(item.validationCommand, "missing"),
                )}</code>`,
            )
            .join("\n") + "\n"
        : "  - 尚無 ordered blocker actions\n")
    : "";
  const operatorPacketText = operatorPacket
    ? `🧾 <b>Operator Execution Packet</b>\n` +
      `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(operatorPacket.status, "unknown")))}</code> operatorCanExecute=${boolBadge(
        operatorPacket.operatorCanExecute,
      )} dispatch=<code>${escapeHtml(textValue(operatorPacketExecution?.dispatchPolicy, "unknown"))}</code>\n` +
      `  machine=<code>${escapeHtml(textValue(operatorPacket.machineLine, "missing"))}</code>\n` +
      `  readiness=<code>${escapeHtml(textValue(operatorPacketReadiness?.status, "unknown"))}</code> adapterAck=<code>${escapeHtml(
        textValue(operatorPacketAdapterAck?.status, "unknown"),
      )}</code> noOrderWrite=${boolBadge(operatorPacketSafety?.noOrderWrite)} sentOrder=${boolBadge(
        operatorPacketSafety?.sentOrder,
      )}\n` +
      `  blockers=${formatInlineBlockerList(operatorPacketBlockers.slice(0, 6))}\n` +
      operatorPacketBlockerPlanText +
      "\n"
    : "";
  const liveCompletionText = liveCompletion
    ? `🧠 <b>策略/實單完成矩陣</b>\n` +
      `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(liveCompletion.status, "unknown")))}</code> operatorCanExecute=${boolBadge(
        liveCompletion.operatorCanExecute,
      )} dispatch=<code>${escapeHtml(textValue(liveCompletion.dispatchPolicy, "unknown"))}</code>\n` +
      `  pass=${escapeHtml(textValue(liveCompletion.passCount, "0"))}/${escapeHtml(
        textValue(liveCompletion.stageCount, "0"),
      )} noLiveOrderSent=${boolBadge(liveCompletion.noLiveOrderSent)} writeBrokerOrders=${boolBadge(
        liveCompletion.writeBrokerOrders,
      )}\n` +
      liveCompletionStages
        .map(
          (stage) =>
            `  - ${escapeHtml(textValue(stage?.id, "unknown"))}: <code>${escapeHtml(
              localizeTradingStatusLabel(textValue(stage?.status, "unknown")),
            )}</code>`,
        )
        .join("\n") +
      `\n\n`
    : "";
  const tailRiskRepairBucketText =
    repairCandidateBuckets.length > 0
      ? repairCandidateBuckets
          .map(
            (bucket) =>
              `  - ${escapeHtml(textValue(bucket.id, "unknown"))}: <code>${escapeHtml(
                localizeTradingStatusLabel(textValue(bucket.status, "unknown")),
              )}</code> count=${escapeHtml(textValue(bucket.candidateCount, "0"))}`,
          )
          .join("\n")
      : "  - 尚無 repair buckets";
  const sameCaseRerunEvidenceText =
    nextPaperCandidateBatch || sameCaseRerunEvidence
      ? `  rerunEvidence=<code>${escapeHtml(
          localizeTradingStatusLabel(textValue(sameCaseRerunEvidence?.status, "unknown")),
        )}</code> nextBatch=<code>${escapeHtml(
          localizeTradingStatusLabel(textValue(nextPaperCandidateBatch?.status, "unknown")),
        )}</code> ranked=<code>${escapeHtml(sameCaseRerunRankingLine || "none")}</code> followUp=<code>${escapeHtml(
          textValue(
            sameCaseRerunEvidence?.followUpCommand ?? nextPaperCandidateBatch?.followUpCommand,
            "missing",
          ),
        )}</code>\n`
      : "";
  const tailRiskRepairText = strategyTailRiskRepair
    ? `🧪 <b>策略 Tail-Risk 修復</b>\n` +
      `  status=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(strategyTailRiskRepair.status, "unknown")),
      )}</code> candidatePlan=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(repairCandidatePlan?.status, "unknown")),
      )}</code> noOrderWrite=${boolBadge(repairCandidatePlan?.noOrderWrite)}\n` +
      sameCaseRerunEvidenceText +
      `${tailRiskRepairBucketText}\n\n`
    : "";
  const localExecutorDispatchText = localExecutorDispatch
    ? `${formatCapitalLocalExecutorDispatchSection(
        localExecutorDispatch as CapitalLocalExecutorDispatchState,
      )}\n\n`
    : "";
  const autoDeactivateReceiptText = autoDeactivateReceiptGate
    ? `🧾 <b>回關收據 Gate</b>\n` +
      `  status=<code>${escapeHtml(localizeTradingStatusLabel(textValue(autoDeactivateReceiptGate.status, "unknown")))}</code> audit=<code>${escapeHtml(
        textValue(autoDeactivateReceiptGate.auditId, "missing"),
      )}</code>\n` +
      `  pendingExplicitExecuteReceipt=${boolBadge(
        autoDeactivateReceiptGate.pendingExplicitExecuteReceipt,
      )} receiptVerified=${boolBadge(
        autoDeactivateReceiptGate.receiptVerified,
      )} heartbeatExecuteAllowed=${boolBadge(
        autoDeactivateReceiptGate.heartbeatExecuteAllowed ??
          autoDeactivateReceiptSafety?.heartbeatExecuteAllowed,
      )}\n` +
      `  execute=${boolBadge(autoDeactivateReceiptGate.execute)} applied=${boolBadge(
        autoDeactivateReceiptGate.applied,
      )} operatorActionRequired=${boolBadge(autoDeactivateReceiptGate.operatorActionRequired)}\n` +
      `  noLiveOrderSent=${boolBadge(
        autoDeactivateReceiptSafety?.noLiveOrderSent,
      )} sentOrder=${boolBadge(
        autoDeactivateReceiptSafety?.sentOrder,
      )} writeBrokerOrders=${boolBadge(autoDeactivateReceiptSafety?.writeBrokerOrders)}\n` +
      `  receiptCheck=<code>${escapeHtml(
        textValue(
          autoDeactivateReceiptValidationCommands?.receiptGate,
          "pnpm capital:live-trading:operator:auto-deactivate:receipt:check",
        ),
      )}</code>\n` +
      `  machine=<code>${escapeHtml(textValue(autoDeactivateReceiptGate.machineLine, "missing"))}</code>\n` +
      `  blockers=${formatInlineBlockerList(autoDeactivateReceiptBlockers)}\n\n`
    : "";

  const text =
    `${nav}\n\n` +
    `🚦 <b>直接操作 Gate</b>\n\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code> 模式=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(state.mode, "unknown")),
    )}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `標的: <code>${escapeHtml(textValue(requestedTrade?.instrument, "A50 202605"))}</code> quote=<code>${escapeHtml(
      textValue(requestedTrade?.quoteSymbol, "CN0000"),
    )}</code> 當沖=<code>${escapeHtml(textValue(requestedTrade?.holdingMode, "day_trade"))}</code>\n` +
    `sealedOrderIntent.sha256: <code>${escapeHtml(sealedHash)}</code>\n\n` +
    liveUnlockChecklistText +
    `📊 <b>報價</b>\n` +
    `  service=<code>${escapeHtml(localizeTradingStatusLabel(textValue(quote?.serviceStatus, "unknown")))}</code> TX=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(quote?.domesticTxFreshness, "unknown")),
    )}</code>\n` +
    `  A50=<code>${escapeHtml(localizeTradingStatusLabel(textValue(quote?.a50Status, "unknown")))}</code> subscribed=${boolBadge(
      quote?.a50Subscribed,
    )} age=${escapeHtml(textValue(quote?.a50AgeSeconds, "無資料"))}s\n\n` +
    `📋 <b>持倉快照</b>\n` +
    `  decision=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(position?.decisionStatus, "unknown")),
    )}</code> active=${boolBadge(activePosition?.exists)} status=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(activePosition?.status, "unknown")),
    )}</code> usable=${boolBadge(activePosition?.usable ?? position?.usable)}\n` +
    `  active=<code>${escapeHtml(textValue(activePosition?.path ?? position?.path, "missing"))}</code>\n` +
    `  freshness=<code>${escapeHtml(
      localizeTradingStatusLabel(
        textValue(activePosition?.freshnessStatus ?? position?.freshnessStatus, "unknown"),
      ),
    )}</code> age=${escapeHtml(
      textValue(activePosition?.verifiedAgeSeconds ?? position?.verifiedAgeSeconds, "無資料"),
    )}s max=${escapeHtml(
      textValue(activePosition?.maxFreshSeconds ?? position?.maxFreshSeconds, "無資料"),
    )}s\n` +
    `  verifiedAt=<code>${escapeHtml(
      textValue(activePosition?.verifiedAt ?? position?.verifiedAt, "missing"),
    )}</code> by=<code>${escapeHtml(
      textValue(activePosition?.verifiedBy ?? position?.verifiedBy, "missing"),
    )}</code>\n` +
    `  template=<code>${escapeHtml(textValue(positionTemplate?.path, "missing"))}</code>\n` +
    `  operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos / pnpm capital:trade:direct:status:check</code> noOrderWrite=${boolBadge(
      true,
    )}\n` +
    positionHandoffText +
    "\n" +
    `🧭 <b>Broker Adapter Ack</b>\n` +
    `  ack=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(adapter?.ackStatus, "unknown")),
    )}</code> active=${boolBadge(activeAck?.exists)} activeStatus=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(activeAck?.status, "unknown")),
    )}</code> usable=${boolBadge(activeAck?.usable ?? adapter?.ackUsable)}\n` +
    `  active=<code>${escapeHtml(textValue(activeAck?.path ?? adapter?.ackPath, "missing"))}</code>\n` +
    `  template=<code>${escapeHtml(textValue(ackTemplate?.path, "missing"))}</code>\n` +
    `  requiredCurrent=<code>${escapeHtml(
      textValue(
        ackRequiredCurrentTemplate?.path ?? operatorPacketAdapterAck?.requiredTemplatePath,
        "missing",
      ),
    )}</code>\n` +
    `  expectedHash=<code>${escapeHtml(
      textValue(
        activeAck?.expectedSealedIntentSha256 ??
          operatorPacketAdapterAck?.expectedSealedIntentSha256,
        "missing",
      ),
    )}</code>\n` +
    `  activeHash=<code>${escapeHtml(
      textValue(
        activeAck?.actualSealedIntentSha256 ?? operatorPacketAdapterAck?.actualSealedIntentSha256,
        "missing",
      ),
    )}</code>\n` +
    `  hashOk=${boolBadge(operatorPacketAdapterAck?.hashOk)} canary=${boolBadge(
      operatorPacketAdapterAck?.canaryPass,
    )} rollback=${boolBadge(operatorPacketAdapterAck?.rollbackPass)}\n` +
    `  canaryNoOrder=${boolBadge(adapterCanaryNoOrder)} rollbackFresh=<code>${escapeHtml(
      localizeTradingStatusLabel(
        textValue(operatorPacketAdapterAck?.rollbackFreshnessStatus, "unknown"),
      ),
    )}</code> rollbackAge=${escapeHtml(
      textValue(operatorPacketAdapterAck?.rollbackAgeSeconds, "無資料"),
    )}s\n` +
    adapterAckHandoffText +
    "\n" +
    adapterPostApplyReadbackText +
    adapterApplyReceiptText +
    operatorPacketText +
    localExecutorDispatchText +
    autoDeactivateReceiptText +
    liveCompletionText +
    tailRiskRepairText +
    `🛡 <b>安全</b>\n` +
    `  noLiveOrderSent=${boolBadge(statusSafety?.noLiveOrderSent ?? inputSafety?.noLiveOrderSent)} sentOrder=${boolBadge(
      statusSafety?.sentOrder ?? inputSafety?.sentOrder,
    )} brokerWriteAttempted=${boolBadge(inputSafety?.brokerWriteAttempted)}\n` +
    `  templatesOnly=${boolBadge(inputSafety?.generatedTemplatesOnly)} wroteActivePosition=${boolBadge(
      inputSafety?.wroteActivePositionSnapshot,
    )} wroteActiveAck=${boolBadge(inputSafety?.wroteActiveAdapterAck)}\n\n` +
    `🚫 <b>阻擋</b>\n  ${formatInlineBlockerList(blockers)}\n\n` +
    `🧩 <b>Operator Steps</b>\n${operatorStepText}\n\n` +
    `➡️ <b>下一步</b>\n${escapeHtml(textValue(state.nextSafeTask, "補齊 verified position snapshot 與 adapter ack。"))}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:direct", style: "primary" },
          {
            label: TRADING_BUTTON_COPY.coreProductQuotes,
            value: "sc:tr:corequote",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.directRun, value: "sc:tr:directrun", style: "success" },
          {
            label: TRADING_BUTTON_COPY.localExecutor,
            value: "sc:tr:localexec",
            style: "primary",
          },
          {
            label: TRADING_BUTTON_COPY.liveExecutorArmProfile,
            value: "sc:tr:armprofile",
            style: "danger",
          },
          {
            label: TRADING_BUTTON_COPY.directPositionRefresh,
            value: "sc:tr:directpos",
            style: "primary",
          },
          {
            label: TRADING_BUTTON_COPY.adapterApplyReceipt,
            value: "sc:tr:ackapply",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.receiptGate, value: "sc:tr:receipt", style: "primary" },
          { label: TRADING_BUTTON_COPY.capitalStatus, value: "sc:tr:cap", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── OKX 狀態面板 ───────────────────────────────────────────────────

export function buildOkxStatusPanel(state: OkxGateState | null): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "OKX 狀態");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🟦 <b>OKX API 狀態</b>\n\n` +
            `目前沒有 OKX 閘門報告。\n\n` +
            `<i>請先執行 pnpm okx:api-status:check 產生最新狀態；若當前就緒摘要過期，執行 pnpm okx:current-readiness:refresh。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            {
              label: TRADING_BUTTON_COPY.okxReadinessRefresh,
              value: "sc:tr:okxrefresh",
              style: "primary",
            },
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okx", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const auth = asRecord(state.authentication);
  const demo = asRecord(auth?.demo);
  const live = asRecord(auth?.live);
  const quote = asRecord(state.quote);
  const safety = asRecord(state.safety);
  const kit = asRecord(state.agentTradeKit);
  const config = asRecord(state.config);
  const credentialPolicy = asRecord(state.credentialPolicy);
  const currentReadinessSummary = asRecord(state.currentReadinessSummary);
  const currentReadinessSafety = asRecord(currentReadinessSummary?.safety);
  const currentReadinessBlockers = stringList(currentReadinessSummary?.blockers);
  const currentReadinessRefreshWorkflow = asRecord(state.currentReadinessRefreshWorkflow);
  const currentReadinessRefreshSafety = asRecord(currentReadinessRefreshWorkflow?.safety);
  const currentReadinessHeartbeatOperation = asRecord(state.currentReadinessHeartbeatOperation);
  const currentReadinessRefreshRun = asRecord(currentReadinessHeartbeatOperation?.refreshRun);
  const currentReadinessRefreshSteps = Array.isArray(currentReadinessRefreshWorkflow?.steps)
    ? currentReadinessRefreshWorkflow.steps.map(asRecord).filter((step) => step !== null)
    : [];
  const currentReadinessRefreshFailedSteps = currentReadinessRefreshSteps
    .filter((step) => textValue(step?.status, "") !== "pass")
    .map((step) => textValue(step?.id, "unknown"));
  const currentReadinessRefreshPassedSteps = currentReadinessRefreshSteps.filter(
    (step) => textValue(step?.status, "") === "pass",
  ).length;
  const marketSnapshotScheduler = asRecord(state.marketSnapshotScheduler);
  const schedulerSchedule = asRecord(marketSnapshotScheduler?.schedule);
  const schedulerSafety = asRecord(marketSnapshotScheduler?.safety);
  const schedulerBlockers = stringList(marketSnapshotScheduler?.blockers);
  const profileFields = asRecord(config?.profileFields);
  const mainProfile = asRecord(profileFields?.main);
  const demoProfile = asRecord(profileFields?.demo);
  const blockers = stringList(state.blockers);
  const markers = stringList(state.markers).slice(0, 8);
  const allowedPermissions = stringList(credentialPolicy?.allowedPermissionSetBeforePromotion);
  const blockedPermissions = stringList(credentialPolicy?.blockedPermissionSetBeforePromotion);

  const blockerText =
    blockers.length > 0
      ? blockers.map((item) => `  ⚠️ ${escapeHtml(item)}`).join("\n")
      : "  ✅ 無額外阻擋";
  const markerText =
    markers.length > 0 ? `\n\n🏷 <b>標記</b>\n  ${markers.map(escapeHtml).join(" / ")}` : "";
  const currentReadinessText = currentReadinessSummary
    ? `🟩 <b>OKX 當前就緒摘要</b>\n` +
      `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(currentReadinessSummary.status, "unknown")),
      )}</code> 代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(currentReadinessSummary.code, "unknown")),
      )}</code>\n` +
      `  機器摘要=<code>${escapeHtml(
        textValue(currentReadinessSummary.machineLine, "missing"),
      )}</code>\n` +
      `  禁止下單寫入=${boolBadge(currentReadinessSafety?.noOrderWrite)} 唯讀=${boolBadge(
        currentReadinessSafety?.readOnly,
      )} 僅摘要=${boolBadge(currentReadinessSafety?.summaryOnly)}\n` +
      `  阻擋=${formatInlineBlockerList(currentReadinessBlockers)}\n` +
      `  刷新=<code>pnpm okx:current-readiness:refresh</code>\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json</code>\n\n`
    : `🟩 <b>OKX 當前就緒摘要</b>\n` +
      `  尚無 OKX 當前就緒摘要\n` +
      `  刷新=<code>pnpm okx:current-readiness:refresh</code>\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json</code>\n\n`;
  const refreshWorkflowRunText = currentReadinessRefreshRun
    ? `  latestRefreshRun=<code>${escapeHtml(
        textValue(currentReadinessRefreshRun.status, "unknown"),
      )}/${escapeHtml(textValue(currentReadinessRefreshRun.exitCode, "null"))}</code> durationMs=<code>${escapeHtml(
        formatUnknownNumber(currentReadinessRefreshRun.durationMs),
      )}</code>\n`
    : `  latestRefreshRun=<code>none</code>\n`;
  const refreshWorkflowText = currentReadinessRefreshWorkflow
    ? `🔁 <b>OKX 刷新流程</b>\n` +
      `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(currentReadinessRefreshWorkflow.status, "unknown")),
      )}</code> 代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(currentReadinessRefreshWorkflow.code, "unknown")),
      )}</code>\n` +
      `  機器摘要=<code>${escapeHtml(
        textValue(currentReadinessRefreshWorkflow.machineLine, "missing"),
      )}</code>\n` +
      `  steps=<code>${currentReadinessRefreshPassedSteps}/${currentReadinessRefreshSteps.length}</code> failedSteps=<code>${escapeHtml(
        formatInlineList(currentReadinessRefreshFailedSteps),
      )}</code>\n` +
      refreshWorkflowRunText +
      `  禁止下單寫入=${boolBadge(currentReadinessRefreshSafety?.noOrderWrite)} 唯讀=${boolBadge(
        currentReadinessRefreshSafety?.readOnly,
      )} 僅摘要=${boolBadge(currentReadinessRefreshSafety?.summaryOnly)}\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json</code>\n\n`
    : `🔁 <b>OKX 刷新流程</b>\n` +
      `  尚無 OKX current-readiness refresh workflow 摘要\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json</code>\n\n`;
  const schedulerText = marketSnapshotScheduler
    ? `🕒 <b>OKX 報價排程</b>\n` +
      `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(marketSnapshotScheduler.status, "unknown")),
      )}</code> 下次=<code>${escapeHtml(
        textValue(schedulerSchedule?.nextRunAt, "unknown"),
      )}</code>\n` +
      `  間隔=<code>${escapeHtml(textValue(schedulerSchedule?.everyMs, "unknown"))}ms</code> 入口=<code>${escapeHtml(
        textValue(schedulerSchedule?.entrypoint, "unknown"),
      )}</code>\n` +
      `  機器摘要=<code>${escapeHtml(
        textValue(marketSnapshotScheduler.machineLine, "missing"),
      )}</code>\n` +
      `  禁止下單寫入=${boolBadge(schedulerSafety?.noOrderWrite)} 唯讀=${boolBadge(
        schedulerSafety?.readOnly,
      )} 公開行情=${boolBadge(schedulerSafety?.publicMarketDataOnly)}\n` +
      `  私有訂單=${boolBadge(schedulerSafety?.privateOrderQueryEnabled === false)} 送單=${boolBadge(
        schedulerSafety?.orderPlacementEnabled === false,
      )} 取消=${boolBadge(schedulerSafety?.cancelOrderEnabled === false)} live=${boolBadge(
        schedulerSafety?.liveTradingEnabled === false,
      )}\n` +
      `  阻擋=${formatInlineBlockerList(schedulerBlockers)}\n` +
      `  檢查=<code>pnpm okx:market-snapshot:scheduler:check</code>\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json</code>\n\n`
    : `🕒 <b>OKX 報價排程</b>\n` +
      `  尚無 OKX 報價排程摘要\n` +
      `  檢查=<code>pnpm okx:market-snapshot:scheduler:check</code>\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json</code>\n\n`;

  const text =
    `${nav}\n\n` +
    `🟦 <b>OKX API 狀態</b>\n\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `摘要: ${escapeHtml(textValue(state.summary_zh_tw, "無資料"))}\n\n` +
    `🧪 <b>模擬</b>\n` +
    `  配置: <code>${escapeHtml(textValue(demo?.profile, "demo"))}</code>\n` +
    `  代碼: <code>${escapeHtml(localizeTradingStatusLabel(textValue(demo?.code, "unknown")))}</code>\n\n` +
    `🔴 <b>實盤</b>\n` +
    `  配置: <code>${escapeHtml(textValue(live?.profile, "main"))}</code>\n` +
    `  代碼: <code>${escapeHtml(localizeTradingStatusLabel(textValue(live?.code, "unknown")))}</code>\n\n` +
    `📊 <b>報價</b>\n` +
    `  ${escapeHtml(textValue(quote?.instId ?? quote?.symbol, "無標的"))} 最新=${escapeHtml(
      textValue(quote?.last, "無資料"),
    )} 代碼=<code>${escapeHtml(localizeTradingStatusLabel(textValue(quote?.code, "unknown")))}</code>\n\n` +
    `🛡 <b>安全</b>\n` +
    `  下單: ${boolBadge(safety?.orderPlacementEnabled)} | 實盤: ${boolBadge(
      safety?.liveTradingEnabled,
    )} | 讀取模式: ${boolBadge(safety?.readOnlyCommandsOnly)}\n` +
    `  已送單: ${boolBadge(safety?.submittedOrder)} | 寫入交易: ${boolBadge(
      safety?.writeTradingEnabled,
    )}\n\n` +
    `🔐 <b>Key / 權限</b>\n` +
    `  本機設定: ${boolBadge(config?.localConfigExists)} | 僅遮罩: ${boolBadge(
      config?.configMaskedOnly,
    )}\n` +
    `  主帳 key=${boolBadge(mainProfile?.apiKeyPresent)} secret=${boolBadge(
      mainProfile?.secretKeyPresent,
    )} passphrase=${boolBadge(mainProfile?.passphrasePresent)}\n` +
    `  模擬 key=${boolBadge(demoProfile?.apiKeyPresent)} secret=${boolBadge(
      demoProfile?.secretKeyPresent,
    )} passphrase=${boolBadge(demoProfile?.passphrasePresent)}\n` +
    `  聊天提供 key 策略: <code>${escapeHtml(
      textValue(credentialPolicy?.chatProvidedCredentialAction, "reject_and_rotate"),
    )}</code>\n` +
    `  升版前允許權限: <code>${escapeHtml(allowedPermissions.join("/") || "read")}</code> | 封鎖權限: <code>${escapeHtml(
      blockedPermissions.join("/") || "trade/withdraw",
    )}</code>\n` +
    `  交易/提領需 IP 白名單: ${boolBadge(
      credentialPolicy?.ipAllowlistRequiredForTradeOrWithdraw,
    )} | 聊天貼出 key 必須撤銷: ${boolBadge(credentialPolicy?.keyPostedInChatMustBeRevoked)}\n\n` +
    currentReadinessText +
    refreshWorkflowText +
    schedulerText +
    `🤖 <b>交易助手工具組</b>\n` +
    `  MCP: ${boolBadge(kit?.mcpCompatible)} | CLI: ${boolBadge(
      kit?.cliCompatible,
    )} | profile 必填: ${boolBadge(kit?.requiredProfileForAuthenticatedCommands)}\n` +
    `  demo profile: <code>${escapeHtml(textValue(kit?.demoProfile, "demo"))}</code>\n\n` +
    `🚫 <b>阻擋</b>\n${blockerText}` +
    markerText +
    `\n\n➡️ <b>下一步</b>\n${escapeHtml(textValue(state.nextSafeTask, "維持唯讀 demo gate。"))}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          {
            label: TRADING_BUTTON_COPY.okxReadinessRefresh,
            value: "sc:tr:okxrefresh",
            style: "primary",
          },
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okx", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── OKX 下單提案面板 ───────────────────────────────────────────────

export function buildOkxOrderProposalPanel(
  state: OkxOrderProposalGateState | null,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "OKX 提案");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `🧾 <b>OKX 下單提案</b>\n\n` +
            `目前沒有 OKX 下單提案閘門報告。\n\n` +
            `<i>請先執行 pnpm okx:order-proposal:check 產生最新狀態。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okxord", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const requestedOrder = asRecord(state.requestedOrder);
  const quote = asRecord(state.quoteContext);
  const checks = asRecord(state.preTradeChecks);
  const safety = asRecord(state.safety);
  const blockers = stringList(state.blockers);
  const markers = stringList(state.markers).slice(0, 8);
  const blockerText =
    blockers.length > 0
      ? blockers.map((item) => `  ⚠️ ${escapeHtml(item)}`).join("\n")
      : "  ✅ 無額外阻擋";
  const markerText =
    markers.length > 0 ? `\n\n🏷 <b>標記</b>\n  ${markers.map(escapeHtml).join(" / ")}` : "";

  const text =
    `${nav}\n\n` +
    `🧾 <b>OKX 下單提案</b>\n\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code>\n` +
    `模式: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.mode, "unknown")))}</code>\n` +
    `代碼: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.code, "unknown")))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `摘要: ${escapeHtml(textValue(state.summary_zh_tw, "無資料"))}\n\n` +
    `📌 <b>提案單</b>\n` +
    `  配置: <code>${escapeHtml(textValue(requestedOrder?.profile, "無資料"))}</code>\n` +
    `  ${escapeHtml(textValue(requestedOrder?.market, "市場"))} ${escapeHtml(
      textValue(requestedOrder?.instId, "無標的"),
    )} ${escapeHtml(textValue(requestedOrder?.side, "方向"))} ${escapeHtml(
      textValue(requestedOrder?.ordType, "委託型態"),
    )}\n` +
    `  交易模式: <code>${escapeHtml(textValue(requestedOrder?.tdMode, "無資料"))}</code> | 數量: <code>${escapeHtml(
      textValue(requestedOrder?.size, "無資料"),
    )}</code> | 可下單: ${boolBadge(requestedOrder?.isActionableOrder)}\n\n` +
    `📊 <b>報價上下文</b>\n` +
    `  ${escapeHtml(textValue(quote?.instId, "無標的"))} 最新=${escapeHtml(
      textValue(quote?.last, "無資料"),
    )} 買一=${escapeHtml(textValue(quote?.bidPx, "無資料"))} 賣一=${escapeHtml(
      textValue(quote?.askPx, "無資料"),
    )}\n\n` +
    `✅ <b>交易前檢查</b>\n` +
    `  API 結構: ${boolBadge(checks?.apiStatusSchemaOk)} | 報價: ${boolBadge(
      checks?.quoteOk,
    )} | 模擬授權: ${boolBadge(checks?.demoAuthOk)}\n` +
    `  金鑰已撤銷: ${boolBadge(checks?.chatPostedKeyRotated)} | IP 安全: ${boolBadge(
      checks?.ipAllowlistSafe,
    )}\n\n` +
    `🛡 <b>安全</b>\n` +
    `  僅模擬: ${boolBadge(safety?.dryRunOnly)} | 可執行: ${boolBadge(
      safety?.executionAllowed,
    )} | 已送單: ${boolBadge(safety?.submittedOrder)}\n` +
    `  下單: ${boolBadge(safety?.orderPlacementEnabled)} | 實盤: ${boolBadge(
      safety?.liveTradingEnabled,
    )} | 寫入交易: ${boolBadge(safety?.writeTradingEnabled)}\n\n` +
    `🚫 <b>阻擋</b>\n${blockerText}` +
    markerText +
    `\n\n➡️ <b>下一步</b>\n${escapeHtml(textValue(state.nextSafeTask, "維持僅模擬提案閘門。"))}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okxord", style: "primary" },
          { label: TRADING_BUTTON_COPY.okxStatus, value: "sc:tr:okx", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

// ── OKX 訂單/撤單狀態面板 ───────────────────────────────────────────────

export function buildOkxOrderStatusPanel(state: OkxOrderStatusGateState | null): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "交易", "OKX 訂單");

  if (!state) {
    return {
      blocks: [
        {
          type: "text",
          text:
            `${nav}\n\n` +
            `📋 <b>OKX 訂單/撤單狀態</b>\n\n` +
            `目前沒有 OKX order status gate 報告。\n\n` +
            `<i>請先執行 pnpm okx:order-status:check 產生最新狀態。</i>`,
        },
        {
          type: "buttons",
          buttons: [
            { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okxstat", style: "primary" },
            { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
          ],
        },
      ],
    };
  }

  const trackedOrder = asRecord(state.trackedOrder);
  const cancelStatus = asRecord(state.cancelStatus);
  const demoSimulation = asRecord(state.demoSimulation);
  const simulatedOrder = asRecord(demoSimulation?.simulatedOrder);
  const simulatedCancel = asRecord(demoSimulation?.simulatedCancel);
  const paperAuditSummary = asRecord(state.paperAuditSummary);
  const paperAuditSafety = asRecord(paperAuditSummary?.safetyAggregate);
  const paperAuditLatest = asRecord(paperAuditSummary?.latestEntry);
  const paperAuditBlockers = stringList(paperAuditSummary?.blockers);
  const safety = asRecord(state.safety);
  const endpoints = asRecord(state.officialEndpointMap);
  const orderDetails = asRecord(endpoints?.orderDetails);
  const pendingOrders = asRecord(endpoints?.pendingOrders);
  const cancelOrder = asRecord(endpoints?.cancelOrder);
  const blockers = stringList(state.blockers);
  const blockerText =
    blockers.length > 0
      ? blockers.map((item) => `  - <code>${escapeHtml(item)}</code>`).join("\n")
      : "  - 無";
  const paperAuditText = paperAuditSummary
    ? `🧾 <b>模擬稽核</b>\n` +
      `  狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(paperAuditSummary.status, "unknown")),
      )}</code> 代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(paperAuditSummary.code, "unknown")),
      )}</code>\n` +
      `  筆數=${escapeHtml(textValue(asRecord(paperAuditSummary.counts)?.totalEntries, "0"))} 全部安全=${boolBadge(
        paperAuditSafety?.allEntriesSafe,
      )}\n` +
      `  最新狀態=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(paperAuditLatest?.status, "none")),
      )}</code> 最新代碼=<code>${escapeHtml(
        localizeTradingStatusLabel(textValue(paperAuditLatest?.code, "none")),
      )}</code>\n` +
      `  已送單=${escapeHtml(
        textValue(paperAuditSafety?.submittedOrder, "0"),
      )} 交易所寫入嘗試=${escapeHtml(
        textValue(paperAuditSafety?.exchangeWriteAttempted, "0"),
      )} 訂單狀態查詢次數=${escapeHtml(
        textValue(paperAuditSafety?.orderStatusQueryExecuted, "0"),
      )} 已送撤單=${escapeHtml(textValue(paperAuditSafety?.cancelSubmitted, "0"))}\n` +
      `  阻擋=${formatInlineBlockerList(paperAuditBlockers)}\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json</code>`
    : `🧾 <b>模擬稽核</b>\n` +
      `  尚無 OKX 模擬稽核摘要閘門\n` +
      `  報告=<code>reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json</code>`;

  const text =
    `${nav}\n\n` +
    `📋 <b>OKX 訂單/撤單狀態</b>\n\n` +
    `狀態: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.status, "unknown")))}</code>\n` +
    `模式: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.mode, "unknown")))}</code>\n` +
    `代碼: <code>${escapeHtml(localizeTradingStatusLabel(textValue(state.code, "unknown")))}</code>\n` +
    `更新: ${escapeHtml(textValue(state.generatedAt, "無資料"))}\n` +
    `摘要: ${escapeHtml(textValue(state.summary_zh_tw, "無資料"))}\n\n` +
    `📌 <b>追蹤訂單</b>\n` +
    `  配置: <code>${escapeHtml(textValue(trackedOrder?.profile, "無資料"))}</code>\n` +
    `  ${escapeHtml(textValue(trackedOrder?.market, "市場"))} ${escapeHtml(
      textValue(trackedOrder?.instId, "無標的"),
    )}\n` +
    `  訂單ID=<code>${escapeHtml(textValue(trackedOrder?.ordId, "無"))}</code> 客戶單號=<code>${escapeHtml(
      textValue(trackedOrder?.clOrdId, "無"),
    )}</code>\n` +
    `  已送單=${boolBadge(trackedOrder?.submittedOrder)} 查詢開啟=${boolBadge(
      trackedOrder?.queryEnabled,
    )} 狀態=<code>${escapeHtml(localizeTradingStatusLabel(textValue(trackedOrder?.orderStatus, "none")))}</code>\n\n` +
    `🧯 <b>撤單</b>\n` +
    `  啟用=${boolBadge(cancelStatus?.cancelOrderEnabled)} 已送出=${boolBadge(
      cancelStatus?.cancelSubmitted,
    )} 狀態=<code>${escapeHtml(localizeTradingStatusLabel(textValue(cancelStatus?.cancelStatus, "not_applicable")))}</code>\n\n` +
    `🧪 <b>模擬生命週期</b>\n` +
    `  模擬代碼=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(demoSimulation?.code, "無資料")),
    )}</code> 狀態=<code>${escapeHtml(
      localizeTradingStatusLabel(textValue(demoSimulation?.status, "無資料")),
    )}</code>\n` +
    `  模擬客戶單號=<code>${escapeHtml(
      textValue(simulatedOrder?.simulatedClientOrderId, "無"),
    )}</code>\n` +
    `  已送單=${boolBadge(simulatedOrder?.submittedOrder)} 交易所寫入嘗試=${boolBadge(
      simulatedOrder?.exchangeWriteAttempted,
    )} 已送撤單=${boolBadge(simulatedCancel?.cancelSubmitted)}\n\n` +
    `${paperAuditText}\n\n` +
    `🛡 <b>安全</b>\n` +
    `  唯讀=${boolBadge(safety?.readOnly)} 僅模擬=${boolBadge(safety?.dryRunOnly)} 可執行=${boolBadge(
      safety?.executionAllowed,
    )}\n` +
    `  下單=${boolBadge(safety?.orderPlacementEnabled)} 撤單=${boolBadge(
      safety?.cancelOrderEnabled,
    )} 已送單=${boolBadge(safety?.submittedOrder)}\n` +
    `  查詢已執行=${boolBadge(safety?.orderStatusQueryExecuted)} 寫入交易=${boolBadge(
      safety?.writeTradingEnabled,
    )}\n\n` +
    `📚 <b>官方端點地圖</b>\n` +
    `  查單: <code>${escapeHtml(textValue(orderDetails?.method, "GET"))} ${escapeHtml(
      textValue(orderDetails?.path, "/api/v5/trade/order"),
    )}</code> (${escapeHtml(localizePermissionLabel(textValue(orderDetails?.permission, "read")))})\n` +
    `  掛單: <code>${escapeHtml(textValue(pendingOrders?.method, "GET"))} ${escapeHtml(
      textValue(pendingOrders?.path, "/api/v5/trade/orders-pending"),
    )}</code> (${escapeHtml(localizePermissionLabel(textValue(pendingOrders?.permission, "read")))})\n` +
    `  撤單: <code>${escapeHtml(textValue(cancelOrder?.method, "POST"))} ${escapeHtml(
      textValue(cancelOrder?.path, "/api/v5/trade/cancel-order"),
    )}</code> (${escapeHtml(localizePermissionLabel(textValue(cancelOrder?.permission, "trade")))})\n\n` +
    `🚫 <b>阻擋</b>\n${blockerText}`;

  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: TRADING_BUTTON_COPY.refresh, value: "sc:tr:okxstat", style: "primary" },
          { label: TRADING_BUTTON_COPY.okxOrderProposal, value: "sc:tr:okxord", style: "primary" },
          { label: TRADING_BUTTON_COPY.okxStatus, value: "sc:tr:okx", style: "primary" },
          { label: TRADING_BUTTON_COPY.backToTrade, value: "sc:trade", style: "primary" },
        ],
      },
    ],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function summarizeUnknownMessage(value: unknown, fallback: string): string {
  const direct = textValue(value, "");
  if (direct.length > 0) {
    return direct;
  }
  const record = asRecord(value);
  if (record) {
    const recordMessage = textValue(
      record.message ??
        record.error ??
        record.reason ??
        record.code ??
        record.status ??
        record.detail,
      "",
    );
    if (recordMessage.length > 0) {
      return recordMessage;
    }
    try {
      const serialized = JSON.stringify(record);
      if (typeof serialized === "string" && serialized.length > 0) {
        return serialized.slice(0, 240);
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

type WriteFailureDiagnostics = {
  failureCode: string;
  submissionCommandReason: string;
  actionHint: string;
};

function resolveWriteFailureDiagnostics(params: {
  status: string;
  blockers: string[];
  errorDetail: string;
}): WriteFailureDiagnostics {
  const failureCode = classifyFastOrderWriteFailureCode(
    params.status,
    params.blockers,
    params.errorDetail,
  );
  const submissionCommandReason = resolveSubmissionCommandEmptyReason(failureCode, params.blockers);
  return {
    failureCode,
    submissionCommandReason,
    actionHint: buildWriteFailureActionHint(failureCode),
  };
}

function buildAssistantWriteFailureAssistInfo(
  refresh: Record<string, unknown> | null,
  fastOrderPaperPattern: Record<string, unknown> | null | undefined,
): { statusStrip: string; actionHint: string } {
  const refreshStatus = textValue(refresh?.status, "");
  const latestStatus = textValue(fastOrderPaperPattern?.latestStatus, "");
  const statusSeed = refreshStatus || latestStatus;
  if (statusSeed.length === 0) {
    return { statusStrip: "", actionHint: "" };
  }
  const refreshBlockers = stringList(refresh?.blockers);
  const statusNormalized = statusSeed.trim().toLowerCase();
  const maybeFailure =
    statusNormalized === "gateway_unreachable" ||
    statusNormalized === "gateway_timeout" ||
    statusNormalized === "gateway_invalid_response" ||
    statusNormalized === "write_failed" ||
    statusNormalized.includes("failed") ||
    statusNormalized.includes("error") ||
    refreshBlockers.length > 0;
  if (!maybeFailure) {
    return { statusStrip: "", actionHint: "" };
  }
  const errorDetail = summarizeUnknownMessage(refresh?.errorDetail, statusSeed);
  const diagnostics = resolveWriteFailureDiagnostics({
    status: statusSeed,
    blockers: refreshBlockers,
    errorDetail,
  });
  return {
    statusStrip: ` 寫入故障=<code>${escapeHtml(diagnostics.failureCode)}/${escapeHtml(
      diagnostics.submissionCommandReason,
    )}</code>`,
    actionHint: diagnostics.actionHint,
  };
}

function buildLiveBlockersWriteFailureHint(params: {
  status: string;
  submissionCommand: string;
  blockers: string[];
  diagnostics: WriteFailureDiagnostics;
}): string {
  if (!isWriteFailureSignal(params.status, params.blockers, params.submissionCommand)) {
    return "";
  }
  return `\n  failureCode=<code>${escapeHtml(
    params.diagnostics.failureCode,
  )}</code> submissionCommandReason=<code>${escapeHtml(
    params.diagnostics.submissionCommandReason,
  )}</code>\n  ${params.diagnostics.actionHint}`;
}

function isWriteFailureSignal(
  status: string,
  blockers: string[],
  submissionCommand: string,
): boolean {
  const normalizedStatus = status.trim().toLowerCase();
  const normalizedBlockers = new Set(blockers.map((item) => item.trim().toLowerCase()));
  if (
    normalizedStatus === "gateway_unreachable" ||
    normalizedStatus === "gateway_timeout" ||
    normalizedStatus === "gateway_invalid_response" ||
    normalizedStatus === "write_failed"
  ) {
    return true;
  }
  if (
    normalizedBlockers.has("gateway:no-response") ||
    normalizedBlockers.has("gateway:invalid-response") ||
    normalizedBlockers.has("broker-command-disabled") ||
    normalizedBlockers.has("telegram-manual-review-required")
  ) {
    return true;
  }
  return submissionCommand.trim().length === 0 && normalizedBlockers.has("gateway:no-response");
}

function buildWriteFailureActionHint(failureCode: string): string {
  return failureCode === "gateway_unreachable" ||
    failureCode === "gateway_timeout" ||
    failureCode === "gateway_invalid_response"
    ? "對策=<code>先按 sc:tr:live 檢查 Gateway，再按 sc:tr:write 重試</code>"
    : failureCode === "broker_command_disabled"
      ? "對策=<code>維持 paper-only，改走 sc:tr:approve / sc:tr:paperloop</code>"
      : failureCode === "manual_review_required"
        ? "對策=<code>先按 sc:tr:audit 檢查審核票，再按 sc:tr:approve</code>"
        : "對策=<code>先按 sc:tr:assist / sc:tr:live，再按 sc:tr:write</code>";
}

function classifyFastOrderWriteFailureCode(
  stateStatus: string,
  blockers: string[],
  errorDetail: string,
): string {
  const normalizedStatus = stateStatus.trim().toLowerCase();
  const normalizedErrorDetail = errorDetail.trim().toLowerCase();
  const normalizedBlockers = new Set(blockers.map((item) => item.trim().toLowerCase()));
  const hasBlocker = (value: string) => normalizedBlockers.has(value);
  if (normalizedStatus === "gateway_timeout" || normalizedErrorDetail.includes("timeout")) {
    return "gateway_timeout";
  }
  if (normalizedStatus === "gateway_invalid_response" || hasBlocker("gateway:invalid-response")) {
    return "gateway_invalid_response";
  }
  if (normalizedStatus === "gateway_unreachable" || hasBlocker("gateway:no-response")) {
    return "gateway_unreachable";
  }
  if (hasBlocker("broker-command-disabled")) {
    return "broker_command_disabled";
  }
  if (hasBlocker("telegram-manual-review-required")) {
    return "manual_review_required";
  }
  if (normalizedStatus === "write_failed") {
    return "write_failed";
  }
  return "write_failure_unknown";
}

function resolveSubmissionCommandEmptyReason(failureCode: string, blockers: string[]): string {
  const normalizedBlockers = new Set(blockers.map((item) => item.trim().toLowerCase()));
  if (
    failureCode === "broker_command_disabled" ||
    normalizedBlockers.has("broker-command-disabled")
  ) {
    return "paper_only_lock";
  }
  if (normalizedBlockers.has("telegram-manual-review-required")) {
    return "manual_review_gate";
  }
  if (failureCode.startsWith("gateway_")) {
    return "gateway_not_ready";
  }
  return "unknown";
}

function localizeTradingStatusLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "unknown":
      return "未知";
    case "missing":
      return "缺失";
    case "none":
      return "無";
    case "not_applicable":
      return "不適用";
    case "not_configured":
      return "未設定";
    case "paper_only":
      return "僅模擬";
    case "hold":
      return "觀望";
    case "wait":
      return "等待";
    case "blocked":
      return "已阻擋";
    case "waiting_market":
      return "等待市場報價";
    case "ready_waiting_fresh_quote":
      return "就緒等待最新報價";
    case "historical_simulated":
      return "歷史模擬";
    case "read_only_order_lifecycle_status":
      return "唯讀訂單生命週期狀態";
    case "no_submitted_order_to_track":
      return "無可追蹤已送單";
    case "ready_read_only":
      return "就緒唯讀";
    case "paper_audit_summary_ready":
      return "模擬稽核摘要就緒";
    case "ready_no_exchange_write":
      return "就緒無交易所寫入";
    case "demo_order_simulation_result_ready":
      return "模擬下單結果就緒";
    case "dry_run_proposal_blocked":
      return "模擬提案已阻擋";
    case "dry_run_proposal_only":
      return "僅模擬提案";
    case "read_only_demo_verified_live_blocked":
      return "唯讀模擬已驗證且實盤阻擋";
    case "okx_current_readiness_ready":
      return "OKX 當前就緒";
    case "blocked_or_degraded":
      return "阻擋或降級";
    case "capital_watchdog_not_ready":
      return "群益監看未就緒";
    case "allowlivetrading_false":
      return "禁止實盤交易";
    case "market_session_closed":
      return "市場休市";
    case "session_closed":
      return "交易時段關閉";
    case "stale":
      return "過期";
    case "stale_callback":
      return "過期 callback";
    case "blocked_a50_stale":
      return "A50 報價過期阻擋";
    case "blocked_until_position_and_adapter":
      return "等待持倉與 adapter";
    case "blocked_no_verified_position_snapshot":
      return "缺 verified position snapshot";
    case "operator_input_templates_only":
      return "僅 operator 輸入模板";
    case "ready":
      return "就緒";
    default:
      return value;
  }
}

function localizePermissionLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return "讀取";
    case "trade":
      return "交易";
    case "withdraw":
      return "提領";
    default:
      return value;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => textValue(item, "")).filter((item) => item.length > 0)
    : [];
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "未知";
}

function formatUnknownNumber(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return escapeHtml(value.trim());
  }
  return "未知";
}

function formatPercent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "未知";
}

function formatShortList(value: string[] | undefined): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "無";
  }
  return value.slice(0, 3).map(escapeHtml).join(" / ");
}

function formatInlineList(value: string[]): string {
  return value.length > 0 ? value.slice(0, 4).map(escapeHtml).join(" / ") : "無";
}

function localizeBlockerLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "broker-command-disabled":
      return "券商指令未啟用";
    case "telegram-manual-review-required":
    case "live_trading_manual_review_required":
      return "需要人工審核";
    case "order_not_enabled":
      return "下單功能未啟用";
    case "ui-high-risk-actions-locked":
      return "高風險操作已鎖定";
    case "freshness_stale":
      return "新鮮度過期";
    case "chat_supplied_secret_must_rotate":
      return "聊天提供的金鑰必須先撤銷輪替";
    case "readiness:not-ready":
      return "整體就緒狀態未達標";
    case "adapterack:not-verified":
      return "Adapter Ack 尚未驗證";
    case "direct:pretrade-not-ready":
      return "直接下單前檢查未就緒";
    case "quote:domestic-and-overseas-fresh":
      return "國內外報價未同時新鮮";
    case "live-risk:runtime-write-forbidden":
      return "風險閘門禁止 runtime 寫入";
    default:
      if (normalized.startsWith("quote_fresh_matched:")) {
        const reason = value.split(":").slice(1).join(":");
        return `報價新鮮度阻擋（${localizeTradingStatusLabel(reason)}）`;
      }
      if (normalized.startsWith("live-risk:")) {
        const reason = value.split(":").slice(1).join(":");
        return `實單風險阻擋（${localizeTradingStatusLabel(reason)}）`;
      }
      return value;
  }
}

function formatBlockerItem(value: string): string {
  const code = value.trim();
  if (!code) {
    return "";
  }
  const localized = localizeBlockerLabel(code);
  if (localized === code) {
    return escapeHtml(code);
  }
  return `${escapeHtml(localized)}（<code>${escapeHtml(code)}</code>）`;
}

function formatInlineBlockerList(value: string[]): string {
  if (value.length === 0) {
    return "無";
  }
  return value
    .slice(0, 4)
    .map((item) => formatBlockerItem(item))
    .filter((item) => item.length > 0)
    .join(" / ");
}

function formatAssistantGateLabel(gateId: string): string {
  switch (gateId) {
    case "quote_freshness":
      return "報價新鮮度";
    case "chart_strategy":
      return "圖表策略";
    case "strategy_learning":
      return "策略學習";
    case "pre_trade_risk_gate":
      return "下單前風險閘門";
    case "live_promotion":
      return "實單升級";
    default:
      return "未分類閘門";
  }
}

function formatAssistantGateRows(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "  - 尚無閘門矩陣";
  }
  return value
    .slice(0, 8)
    .map((item) => {
      const gate = asRecord(item);
      const evidence = asRecord(gate?.evidence);
      const blockers = stringList(evidence?.blockers);
      const gateId = textValue(gate?.id, "未知");
      const blockerSuffix = blockers.length > 0 ? ` 阻擋 ${formatInlineBlockerList(blockers)}` : "";
      return `  - ${escapeHtml(formatAssistantGateLabel(gateId))} <code>${escapeHtml(gateId)}</code>: <code>${escapeHtml(
        textValue(gate?.status, "未知"),
      )}</code>${blockerSuffix}`;
    })
    .join("\n");
}

function hasBlockerSnapshot(state: StrategyPanelState): boolean {
  return Boolean(
    state.quoteGateStatus ||
    state.quoteReportableStatus ||
    state.quoteBlockedCount !== undefined ||
    state.learningStatus ||
    state.fullChainStatus ||
    state.livePromotionStatus ||
    state.livePromotionBlockerCode,
  );
}

function boolBadge(value: unknown): string {
  if (value === true) {
    return "✅";
  }
  if (value === false) {
    return "❌";
  }
  return "未知";
}
