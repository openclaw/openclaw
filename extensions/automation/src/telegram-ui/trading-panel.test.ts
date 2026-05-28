import { describe, expect, it } from "vitest";
import { TRADING_BUTTON_COPY } from "./trading-copy.js";
import type { TelegramTradingShortcutsSummaryState, TradingState } from "./trading-panel.js";
import {
  buildAiTradingPlatformPanel,
  buildCapitalDirectOperationPanel,
  buildCapitalLocalExecutorDispatchPanel,
  buildCapitalLiveExecutorArmProfilePanel,
  buildCapitalServiceStatusPanel,
  buildCapitalPaperAssistantPanel,
  buildFastOrderAuditTrailPanel,
  buildFastOrderIntentReviewPanel,
  buildFastOrderIntentWritePanel,
  buildLearningSummaryPanel,
  buildOkxOrderProposalPanel,
  buildOkxOrderStatusPanel,
  buildOkxStatusPanel,
  buildPaperOrderPanel,
  buildQuoteDetailPanel,
  buildStrategyPanel,
  buildTradingPanel,
} from "./trading-panel.js";

function getTextBlocksText(panel: { blocks: Array<{ type: string; text?: string }> }) {
  return panel.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getButtonValues(
  panel: ReturnType<
    | typeof buildTradingPanel
    | typeof buildAiTradingPlatformPanel
    | typeof buildFastOrderAuditTrailPanel
    | typeof buildFastOrderIntentReviewPanel
    | typeof buildFastOrderIntentWritePanel
    | typeof buildPaperOrderPanel
    | typeof buildQuoteDetailPanel
    | typeof buildStrategyPanel
    | typeof buildCapitalDirectOperationPanel
    | typeof buildCapitalLocalExecutorDispatchPanel
    | typeof buildCapitalLiveExecutorArmProfilePanel
    | typeof buildCapitalServiceStatusPanel
    | typeof buildCapitalPaperAssistantPanel
    | typeof buildLearningSummaryPanel
    | typeof buildOkxStatusPanel
    | typeof buildOkxOrderProposalPanel
    | typeof buildOkxOrderStatusPanel
  >,
) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

function buildLocalExecutorDispatchFixture() {
  return {
    generatedAt: "2026-05-25T17:15:33.383Z",
    status: "blocked",
    mode: "local_broker_executor_dispatch_contract_report_only",
    sealedIntentSha256: "ABC123",
    dispatchPolicy: "blocked_do_not_send",
    machineLine:
      "capitalLocalExecutorDispatch=blocked sha256=ABC123 operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send payloadHash=PAYLOAD123 noOrderWrite=true sentOrder=false blockers=3",
    operatorPacket: {
      status: "blocked",
      operatorCanExecute: false,
      readinessStatus: "blocked",
      adapterAckStatus: "blocked",
      dispatchPolicy: "blocked_do_not_send",
      blockers: ["readiness:not-ready", "adapterAck:not-verified", "direct:pretrade-not-ready"],
    },
    executor: {
      id: "openclaw-managed-capital-live-executor",
      armed: false,
      armStatus: "unarmed",
      armProfilePath: "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
      credentialOwner: "local_broker_executor",
    },
    dispatchContract: {
      payloadHash: "PAYLOAD123",
      commandPayload: {
        stockNo: "CN0000",
        buySell: "buy",
        qty: 1,
        dayTradeMode: "explicit_required",
      },
      sealedOrderIntent: { sha256: "ABC123" },
    },
    blockers: [
      "operatorPacket:not-executable",
      "executor:arm-profile-not-armed",
      "operatorPacket:readiness:not-ready",
    ],
    safety: {
      noLiveOrderSent: true,
      no_live_order_sent: true,
      sentOrder: false,
      brokerApiCalled: false,
      wroteBrokerCommand: false,
      writeBrokerOrders: false,
    },
    paths: {
      reportPath:
        "D:\\OpenClaw\\reports\\hermes-agent\\state\\openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
    },
    nextSafeTask: "Keep local executor dispatch blocked until gates pass.",
  };
}

function buildLiveExecutorArmProfileFixture() {
  return {
    schema: "openclaw.capital.live-executor-arm-profile.v1",
    generatedAt: "2026-05-26T18:34:02.447Z",
    status: "expired",
    mode: "operator_managed_live_executor_arm_profile",
    executorId: "openclaw-managed-capital-live-executor",
    profileExists: true,
    profileReadStatus: "loaded",
    armed: true,
    allowBrokerWriteWhenAllGatesPass: false,
    allowConversationAgentDirectWrite: false,
    brokerWriteAuthorityTarget: "openclaw_managed_local_broker_executor",
    operatorSignaturePresent: true,
    armedAt: "2026-05-26T10:14:17.063Z",
    expiresAt: "2026-05-26T10:29:17.063Z",
    ttlSeconds: 900,
    maxTtlSeconds: 900,
    expired: true,
    blockers: ["arm_profile:expired"],
    requirements: {
      killSwitch: true,
      canaryRequired: true,
      rollbackRequired: true,
      freshQuoteRequired: true,
      verifiedPositionRequired: true,
      adapterAckHashRequired: true,
    },
    profileRequirementsObserved: {
      killSwitch: true,
      canaryRequired: true,
      rollbackRequired: true,
      freshQuoteRequired: true,
      verifiedPositionRequired: true,
      adapterAckHashRequired: true,
    },
    safety: {
      sentOrder: false,
      noLiveOrderSent: true,
      brokerWriteAttempted: false,
      generatedStagedRearmProfile: true,
      wroteActiveArmProfile: false,
      activeArmProfileWriteSuppressed: true,
      conversationAgentDirectBrokerWrite: false,
      reportOnly: true,
    },
    paths: {
      profilePath: "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
      templatePath:
        "D:\\OpenClaw\\.openclaw\\trading\\templates\\capital-live-executor-arm-profile.template.json",
      stagedRearmProfilePath:
        "D:\\OpenClaw\\.openclaw\\trading\\staging\\capital-live-executor-arm-profile.staged-rearm.json",
      reportPath:
        "D:\\OpenClaw\\reports\\hermes-agent\\state\\openclaw-capital-live-executor-arm-profile-latest.json",
    },
    template: {
      note: "Copy to .openclaw/trading/capital-live-executor-arm-profile.json only when the local broker executor is intentionally armed.",
    },
    operatorReview: {
      status: "staged_rearm_candidate_ready_for_operator",
      activeProfilePath: "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
      stagedRearmProfilePath:
        "D:\\OpenClaw\\.openclaw\\trading\\staging\\capital-live-executor-arm-profile.staged-rearm.json",
      templatePath:
        "D:\\OpenClaw\\.openclaw\\trading\\templates\\capital-live-executor-arm-profile.template.json",
      activeProfileWriteSuppressed: true,
      conversationAgentsMayWriteActiveProfile: false,
      allowedWriter: "operator-managed-local-broker-executor-only",
      validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check",
      postRearmValidationCommand: "pnpm --dir D:\\OpenClaw capital:live-readiness:check",
      rearmCandidate: {
        armed: false,
        activeProfileWriteSuppressed: true,
        allowedWriter: "operator-managed-local-broker-executor-only",
      },
      handoffChecklist: [
        {
          order: 1,
          id: "review_staged_rearm_profile",
          status: "pending_operator_review",
          validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check",
        },
        {
          order: 2,
          id: "operator_managed_active_profile_rearm",
          status: "pending_operator_managed_executor",
          validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check",
        },
        {
          order: 3,
          id: "rerun_live_readiness",
          status: "blocked_until_executor_armed",
          validationCommand: "pnpm --dir D:\\OpenClaw capital:live-readiness:check",
        },
      ],
    },
    machineLine:
      "capitalLiveExecutorArmProfile=expired armed=true allowExecutorWrite=false expired=true ttlSeconds=900 killSwitch=true noOrderWrite=true sentOrder=false blockers=1",
    nextSafeTask:
      "Fill and review .openclaw/trading/capital-live-executor-arm-profile.json, then rerun pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check.",
  };
}

function buildShortcutGateSummaryFixture(
  generatedAt = "2026-05-24T14:55:47.578Z",
): TelegramTradingShortcutsSummaryState {
  return {
    generatedAt,
    status: "pass",
    summary: {
      checks: 192,
      failed: 0,
      shortcutCheckCountClosure: {
        total: 192,
        failed: 0,
        assistantClosureChecks: 42,
        okxClosureChecks: 18,
        fixtureCoverageChecks: 4,
        reportMachineChecks: 12,
        machineLine:
          "shortcutChecks=192 failed=0 assistantClosure=42 okxClosure=18 fixtureCoverage=4 reportMachine=12 growthReason=assistant+okx+fixture+report-machine",
      },
      fixtureCoverage: {
        status: "pass",
        checkId: "fast-ticket-audit:callback-learning-summary-shared-formatter-fixture",
        targets: ["callback-router.test.ts", "trading-panel.test.ts"],
      },
      okxPaperAuditClosure: {
        status: "pass",
        callbackPair: ["sc:tr:platform", "sc:tr:okxstat"],
        platformSnapshotRead: true,
        platformVisible: true,
        okxStatusRead: true,
        okxStatusVisible: true,
        noOrderWrite: true,
        reportPath: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
        machineLine:
          "okxPaperAudit=pass platform=read+visible okxstat=read+visible report=reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json noOrderWrite=true",
      },
      okxCurrentReadinessClosure: {
        status: "ready",
        callbackPair: ["sc:tr:okx", "sc:tr:assist"],
        okxStatusRead: true,
        okxStatusVisible: true,
        assistantSummaryRead: true,
        assistantStatusStripVisible: true,
        noOrderWrite: true,
        reportPath: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
        machineLine:
          "okxCurrentReadiness=ready okx=read+visible assist=read+visible report=reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json freshness=ok noOrderWrite=true",
      },
      okxCurrentReadinessRefreshWorkflowClosure: {
        status: "ready_read_only",
        code: "okx_current_readiness_refresh_ready",
        callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
        totalSteps: 7,
        passedSteps: 7,
        failedSteps: [],
        latestRefreshRunStatus: "skipped_not_needed",
        latestRefreshRunExitCode: "null",
        noOrderWrite: true,
        reportPath:
          "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
        machineLine:
          "okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true",
      },
      okxCurrentReadinessHeartbeatOperationClosure: {
        status: "ready_idle_read_only",
        code: "okx_current_readiness_heartbeat_ready_idle",
        callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
        telegramCallback: "sc:tr:okxrefresh",
        refreshCommand: "pnpm okx:current-readiness:refresh",
        heartbeatCommand: "pnpm okx:current-readiness:heartbeat",
        executeCommand: "pnpm okx:current-readiness:heartbeat:execute",
        oneClickRefresh: true,
        executeRequired: false,
        noOrderWrite: true,
        inventoryProbeStatus: "ready",
        inventoryProbeReady: true,
        inventoryProbeNoOrderWrite: true,
        inventoryProbeMachineLine:
          "okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true",
        publishBridgeStatusReady: true,
        publishBridgeMachineLine:
          "publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1",
        upstreamNoOrderWriteVerified: true,
        upstreamOkxContractVerified: true,
        upstreamDmadGateVerified: true,
        upstreamNoOrderWriteCount: 4,
        upstreamExecuteRequiredCount: 1,
        upstreamOkxContractCount: 1,
        upstreamDmadGateCount: 1,
        schedulerNextRunAt: "2026-05-24T20:15:00.000Z",
        nextSafeTask:
          "OKX current-readiness 已 ready；維持 heartbeat 監看，必要時從 sc:tr:okxrefresh 觸發安全刷新。",
        reportPath:
          "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
        machineLine:
          "okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true",
      },
      okxHeartbeatPublishTokenCountClosure: {
        status: "ready",
        reportRead: true,
        messageTokenCounts: {
          okxRefresh: 1,
          okxHeartbeat: 1,
          okxContract: 1,
          localExecutorDispatch: 1,
          positionSnapshot: 1,
          executeRequired: 1,
          noOrderWrite: 4,
          dmadGate: 1,
        },
        summaryZhTw:
          "messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1",
        noOrderWrite: true,
        reportPath:
          "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
        machineLine:
          "okxHeartbeatPublishTokenCounts=pass okxRefresh=1 okxHeartbeat=1 okxContract=1 executeRequired=1 noOrderWriteCount=3 summary=present report=reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json noOrderWrite=true",
      },
      capitalHighConfidencePaperRerunClosure: {
        status: "visible_blocked",
        reportRead: true,
        gateStatus: "high_confidence_rerun_completed_still_blocked",
        threshold: 0.6,
        requiredConfidence: 1.306666,
        requiredConfidenceStatus: "impossible_under_current_signal_model",
        candidateCount: 5,
        candidateSymbols: ["CD0000", "YM0000", "ES0000", "GC0000", "NQ0000"],
        passCount: 0,
        blockedCount: 5,
        blockers: ["required_confidence_above_one"],
        noOrderWrite: true,
        sentOrder: false,
        reportPath:
          "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
        machineLine:
          "highConfidencePaperRerun=high_confidence_rerun_completed_still_blocked;threshold=0.6;requiredConfidence=1.306666;candidates=CD0000|YM0000|ES0000|GC0000|NQ0000;pass=0;blocked=5;noOrderWrite=true",
      },
      capitalVerifiedPositionSnapshotClosure: {
        status: "stale_operator_refresh_required",
        reportRead: true,
        usable: true,
        decisionStatus: "verified_flat_no_exit_required",
        freshnessStatus: "stale",
        verifiedAgeSeconds: 44623,
        maxFreshSeconds: 43200,
        hasOpenPosition: false,
        netContracts: 0,
        path: "D:\\OpenClaw\\config\\capital-verified-position-snapshot.json",
        nextCommand: "pnpm capital:trade:direct:status:check",
        noOrderWrite: true,
        sentOrder: false,
        machineLine:
          "capitalVerifiedPositionSnapshot=stale_operator_refresh_required;decision=verified_flat_no_exit_required;freshness=stale;age=44623;maxFresh=43200;hasOpenPosition=false;net=0;path=D:\\OpenClaw\\config\\capital-verified-position-snapshot.json;next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check;noOrderWrite=true",
      },
      assistantClosure: {
        quickLinks: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop"],
        quickLinksVerifiedByChecks: ["sc:tr:audit", "sc:tr:learn", "sc:tr:paperloop"],
        quickLinksMatchPassedChecks: true,
        paperOnlySafetyVisible: true,
        paperLoopLearningRefresh: {
          callback: "sc:tr:paperloop",
          visibleInPaperLoop: true,
          visibleInAssistant: true,
          visibleInShortcutGate: true,
          brokerCommandLocked: true,
        },
        assistantLearningHint: {
          callback: "sc:tr:assist",
          nextSafeCommand: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
          nextCommandShortRow: {
            command: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
            gateVerified: true,
            buttons: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
            machineLine:
              "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
          },
          quickLinks: ["sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
          quickLinksVerifiedByChecks: ["sc:tr:assist", "sc:tr:audit", "sc:tr:paperloop"],
          quickLinksMatchPassedChecks: true,
          brokerCommandLocked: true,
        },
      },
    },
  };
}

describe("telegram-ui trading panel", () => {
  it("escapes quote symbol and name html content", () => {
    const panel = buildQuoteDetailPanel([
      {
        symbol: "<TX00>",
        name: "期貨&主連",
        price: 12345,
        change: 5,
        changePercent: 0.12,
        volume: 1000,
        updatedAt: Date.now() - 1000,
        fresh: true,
      },
    ]);
    const text = getTextBlocksText(panel);
    expect(text).toContain("&lt;TX00&gt;");
    expect(text).toContain("期貨&amp;主連");
  });

  it("escapes blocked reason and signal html content", () => {
    const panel = buildStrategyPanel({
      paperLoop: "blocked",
      blockReason: '風控<&>"',
      lastSignal: "BUY<突破>&",
      lastSignalAt: Date.now() - 1000,
      winRate: 0.6,
      totalTrades: 10,
    });
    const text = getTextBlocksText(panel);
    expect(text).toContain('風控&lt;&amp;&gt;"');
    expect(text).toContain("BUY&lt;突破&gt;&amp;");
  });

  it("renders chart strategy status and live gate in strategy panel", () => {
    const panel = buildStrategyPanel(
      {
        paperLoop: "blocked",
        blockReason: "blocked_quote_stale",
        chartStrategyStatus: "ready_waiting_fresh_quote",
        chartDataReady: true,
        strategyBookReady: true,
        strategyCount: 17,
        enabledStrategyCount: 17,
        simulationStatus: "pass",
        simulationWinRate: 0.5,
        simulationPaperIntentCount: 57,
        fillSimulationStatus: "historical_simulated",
        fillRecommendation: "hold",
        fillTotalIntents: 7,
        fillFilledCount: 6,
        fillRate: 0.8571,
        fillWinRate: 0.5,
        expectedValuePts: 98.59,
        monteCarloP05Pts: -234.8,
        monteCarloP50Pts: 522.1,
        monteCarloP95Pts: 1276.1,
        monteCarloPositiveRate: 0.824,
        fillPaperOnly: true,
        fillExecutionEligible: false,
        fillPromotionBlocked: true,
        quoteGateStatus: "stale",
        quoteLatestStock: "TX00AM",
        quoteFreshnessAgeSeconds: 241,
        quoteMaxAllowedFreshAgeSeconds: 2,
        quoteReportableStatus: "partial_ready",
        quoteReportableCount: 0,
        quoteBlockedCount: 57,
        quoteBlockedCategory: "session_closed",
        quoteBlockedReason: "closed_session_stale",
        quoteUnblockCondition: "market session opens and a fresh matched callback arrives.",
        quoteServiceAlive: true,
        quoteRealtimeRunning: false,
        quoteLatestCallbackAt: "2026-05-24T11:58:17.3393555+08:00",
        learningStatus: "blocked",
        learningPaperEligible: false,
        consecutiveReadinessBlocks: 57,
        latestQuoteAgeSeconds: 241,
        fullChainStatus: "blocked",
        fullChainStageFailedCount: 1,
        fullChainFaultFailedCount: 112,
        fullChainBlockers: ["quote:domestic-and-overseas-fresh", "fault:normal_paper_chain"],
        livePromotionStatus: "blocked",
        livePromotionBlockerCode: "LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED",
        livePromotionBlockers: ["live:full-chain-dryrun-fault-gate-clear"],
        readyForManualReview: false,
        realQuoteVerified: false,
        brokerWriteLocked: true,
        liveOrderAllowed: false,
        nextSafeTask: "等待新的 SKQuoteLib quote callback。",
      },
      {
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
        },
        history: {
          entries: [
            { kind: "paper", status: "paper_execution_recorded" },
            { kind: "review", decision: "deny", status: "denied" },
          ],
        },
      },
    );

    const text = getTextBlocksText(panel);

    expect(text).toContain("圖表策略");
    expect(text).toContain("ready_waiting_fresh_quote");
    expect(text).toContain("策略: 17/17 已啟用");
    expect(text).toContain("勝率 50.0%");
    expect(text).toContain("模擬意圖 57");
    expect(text).toContain("實單允許: ❌");
    expect(text).toContain("Broker 寫入鎖: ✅");
    expect(text).toContain("真報價驗證: ❌");
    expect(text).toContain("成交模擬");
    expect(text).toContain("historical_simulated");
    expect(text).toContain("建議: <code>hold</code>");
    expect(text).toContain("成交: 6/7");
    expect(text).toContain("成交率 85.7%");
    expect(text).toContain("期望值: 98.59 pts");
    expect(text).toContain("蒙地卡羅 p05/p50/p95: -234.8/522.1/1276.1 pts");
    expect(text).toContain("正報酬 82.4%");
    expect(text).toContain("僅模擬: ✅");
    expect(text).toContain("執行資格: ❌");
    expect(text).toContain("升級阻擋: ✅");
    expect(text).toContain("即時阻擋");
    expect(text).toContain("報價: <code>stale</code> TX00AM 時效 241/2s");
    expect(text).toContain("回調: 服務 ");
    expect(text).toContain(" | 即時 ❌ | 最新 ");
    expect(text).toContain("可報價: 0 / 阻擋 57");
    expect(text).toContain("session_closed");
    expect(text).toContain("closed_session_stale");
    expect(text).toContain("學習: <code>blocked</code> 模擬 ❌");
    expect(text).toContain("報價時效 241s");
    expect(text).toContain("就緒阻擋 57");
    expect(text).toContain("全鏈路: <code>blocked</code> 階段/故障 1/112");
    expect(text).toContain("fault:normal_paper_chain");
    expect(text).toContain("LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED");
    expect(text).toContain("快速進出場模擬模式");
    expect(text).toContain("學習模式: 成功=1 失敗=1");
    expect(text).toContain("mixed-paper-pattern");
    expect(text).toContain("brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)");
    expect(getButtonValues(panel)).toContain("sc:tr:rerun");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
    expect(getButtonValues(panel)).toContain("sc:tr:auto");
    expect(getButtonValues(panel)).toContain("sc:tr:audit");
  });

  it("renders AI trading platform snapshot with provider gates and locked fast ticket", () => {
    const panel = buildAiTradingPlatformPanel(
      {
        ts: 1_779_611_200_000,
        mode: "paper_only",
        safety: {
          liveTradingEnabled: false,
          paidProviderEnabled: false,
          writesEnabled: false,
          highRiskEnabled: false,
        },
        runtime: { totalFeeds: 2, connectedFeeds: 1, runningFeeds: 1 },
        platform: {
          status: "waiting_market",
          title: "AI trading platform waiting for fresh market quotes",
          providers: [
            {
              id: "capital",
              label: "Capital",
              status: "blocked",
              ready: false,
              blockerCount: 1,
              blockers: ["quote:domestic-and-overseas-fresh"],
              summary: "Capital full-chain blocked: stage=1, fault=0.",
            },
            {
              id: "okx",
              label: "OKX",
              status: "read_only_demo_verified_live_blocked",
              ready: false,
              blockerCount: 1,
              blockers: ["order_not_enabled"],
              summary: "OKX demo=demo_ok；live=live_401",
            },
          ],
          okxPaperAuditSummary: {
            status: "ready_read_only",
            code: "paper_audit_summary_ready",
            totalEntries: 1,
            latestStatus: "ready_no_exchange_write",
            latestCode: "demo_order_simulation_result_ready",
            allEntriesSafe: true,
            submittedOrderCount: 0,
            exchangeWriteAttemptedCount: 0,
            orderStatusQueryExecutedCount: 0,
            cancelSubmittedCount: 0,
            blockers: [],
            reportPath: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
          },
          strategy: {
            status: "ready_waiting_fresh_quote",
            symbol: "TX00",
            quoteSymbol: "TX00AM",
            signalsGenerated: 57,
            intentsReady: 7,
            fillStatus: "historical_simulated",
            fillRecommendation: "hold",
            aiBrainReady: true,
            aiModuleCount: 6,
          },
          fastOrderTicket: {
            provider: "capital",
            mode: "gated_live_ticket",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            entry: "market",
            exit: "SL=420 TP=440",
            brokerApi: "SendFutureOrder",
            executionAllowed: false,
            liveOrderAllowed: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
            blockerCount: 2,
            blockers: ["quote:domestic-and-overseas-fresh", "ui-high-risk-actions-locked"],
            nextCommand: "capital-hft:capital:full-chain",
          },
        },
      },
      {
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          symbol: "TX00",
          side: "buy",
          quantity: 1,
        },
        history: {
          entries: [
            {
              kind: "paper_execution",
              status: "paper_execution_recorded",
              decision: "approve_paper",
            },
            { kind: "review", status: "denied", decision: "deny" },
          ],
        },
      },
    );
    const text = getTextBlocksText(panel);

    expect(text).toContain("AI 交易平台");
    expect(text).toContain("等待市場報價");
    expect(text).toContain("券商閘門");
    expect(text).toContain("Capital");
    expect(text).toContain("OKX");
    expect(text).toContain("OKX 模擬稽核");
    expect(text).toContain("模擬稽核摘要就緒");
    expect(text).toContain("全部安全=✅");
    expect(text).toContain("已送單=0");
    expect(text).toContain("openclaw-okx-paper-audit-summary-latest.json");
    expect(text).toContain("策略引擎");
    expect(text).toContain("就緒等待最新報價");
    expect(text).toContain("快速進出場學習");
    expect(text).toContain("學習模式: 成功=1 失敗=1");
    expect(text).toContain("模式=<code>mixed-paper-pattern</code>");
    expect(text).toContain("快速進出場票");
    expect(text).toContain("SendFutureOrder");
    expect(text).toContain("可執行=❌");
    expect(text).toContain("允許實單=❌");
    expect(text).toContain("券商指令可用=❌");
    expect(text).toContain("送單指令=(空白)");
    expect(text).toContain("ui-high-risk-actions-locked");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
    expect(getButtonValues(panel)).toContain("sc:tr:auto");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
    expect(getButtonValues(panel)).toContain("sc:tr:platform");
    expect(getButtonValues(panel)).toContain("sc:tr:live");
  });

  it("renders AI trading platform learning from assistant fast order pattern", () => {
    const panel = buildAiTradingPlatformPanel({
      ts: 1_779_611_200_000,
      mode: "paper_only",
      safety: {
        liveTradingEnabled: false,
        paidProviderEnabled: false,
        writesEnabled: false,
        highRiskEnabled: false,
      },
      runtime: { totalFeeds: 0, connectedFeeds: 0, runningFeeds: 0 },
      platform: {
        status: "ready_for_review",
        title: "AI trading platform ready for manual review",
        providers: [],
        fastOrderPaperPattern: {
          pattern: "paper-success",
          successCount: 2,
          failureCount: 0,
          latestStatus: "paper_execution_recorded",
          latestSymbol: "MXFFX999",
          latestSide: "buy",
          latestQuantity: 1,
          brokerCommandEnabled: false,
          sentBrokerOrder: false,
          submissionCommand: "",
        },
      },
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("快速進出場學習");
    expect(text).toContain("學習模式: 成功=2 失敗=0");
    expect(text).toContain("MXFFX999 buy ×1");
    expect(text).toContain("模式=<code>paper-success</code>");
  });

  it("renders live blockers write-failure diagnostics in AI trading platform ticket section", () => {
    const panel = buildAiTradingPlatformPanel({
      ts: 1_779_611_200_000,
      mode: "paper_only",
      safety: {
        liveTradingEnabled: false,
        paidProviderEnabled: false,
        writesEnabled: false,
        highRiskEnabled: false,
      },
      runtime: { totalFeeds: 1, connectedFeeds: 0, runningFeeds: 0 },
      platform: {
        status: "waiting_market",
        title: "AI trading platform waiting for fresh market quotes",
        providers: [],
        fastOrderTicket: {
          provider: "capital",
          symbol: "TX00",
          side: "buy",
          quantity: 1,
          entry: "market",
          exit: "SL=420 TP=440",
          brokerApi: "SendFutureOrder",
          executionAllowed: false,
          liveOrderAllowed: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
          status: "gateway_unreachable",
          blockers: ["gateway:no-response"],
          errorDetail: "Call to 'trading.fastOrderIntent.write' failed: ETIMEDOUT",
        },
      },
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("failureCode=<code>gateway_unreachable</code>");
    expect(text).toContain("submissionCommandReason=<code>gateway_not_ready</code>");
    expect(text).toContain("對策=<code>先按 sc:tr:live 檢查 Gateway，再按 sc:tr:write 重試</code>");
  });

  it("renders written fast order intent evidence without broker submission", () => {
    const panel = buildFastOrderIntentWritePanel({
      generatedAt: "2026-05-24T07:00:00.000Z",
      status: "written_broker_locked",
      intentId: "20260524070000000-capital-TX00-buy",
      source: "telegram.ai-platform",
      mode: "paper_only",
      ticket: {
        provider: "capital",
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        executionAllowed: false,
        liveOrderAllowed: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["broker-command-disabled"],
      },
      blockers: ["broker-command-disabled", "telegram-manual-review-required"],
      brokerCommandEnabled: false,
      submissionCommand: "",
      sentBrokerOrder: false,
      writeTargets: {
        jsonl: ".openclaw/trading/telegram-fast-order-intents.jsonl",
        latestReport: "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
      },
      nextSafeTask: "人工審核此 OpenClaw intent。",
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("快速進出場審核票已寫入");
    expect(text).toContain("written_broker_locked");
    expect(text).toContain("20260524070000000-capital-TX00-buy");
    expect(text).toContain("brokerCommandEnabled=❌");
    expect(text).toContain("submissionCommand=(empty)");
    expect(text).toContain("sentBrokerOrder=❌");
    expect(text).toContain(".openclaw/trading/telegram-fast-order-intents.jsonl");
    expect(text).toContain("openclaw-telegram-fast-order-intent-latest.json");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
    expect(getButtonValues(panel)).toContain("sc:tr:approve");
    expect(getButtonValues(panel)).toContain("sc:tr:deny");
    expect(getButtonValues(panel)).toContain("sc:tr:platform");
  });

  it("renders fast order intent write failure diagnostics and retry command", () => {
    const panel = buildFastOrderIntentWritePanel({
      generatedAt: "2026-05-25T09:33:00.000Z",
      status: "gateway_unreachable",
      blockers: ["gateway:no-response"],
      errorDetail: {
        message: "Call to 'trading.fastOrderIntent.write' failed: ETIMEDOUT",
      },
      retryCommand: "sc:tr:write",
      nextSafeTask: "確認 Automation Gateway 已連線，然後重試。",
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("寫入失敗或 Gateway 無回應。");
    expect(text).toContain("status=<code>gateway_unreachable</code>");
    expect(text).toContain("failureCode=<code>gateway_unreachable</code>");
    expect(text).toContain(
      "errorDetail=<code>Call to 'trading.fastOrderIntent.write' failed: ETIMEDOUT</code>",
    );
    expect(text).toContain("submissionCommandReason=<code>gateway_not_ready</code>");
    expect(text).toContain("retry=<code>sc:tr:write</code>");
    expect(text).toContain("diagnose=<code>sc:tr:live / sc:tr:assist / sc:tr:write</code>");
    expect(text).toContain("操作順序=<code>sc:tr:live → sc:tr:write → sc:tr:audit</code>");
    expect(text).toContain("對策=<code>先按 sc:tr:live 檢查 Gateway，再按 sc:tr:write 重試</code>");
    expect(text).toContain("blockers=gateway:no-response");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
    expect(getButtonValues(panel)).toContain("sc:tr:live");
    expect(getButtonValues(panel)).toContain("sc:tr:assist");
    expect(getButtonValues(panel)).toContain("sc:trade");
  });

  it("renders fast order approve review as paper-only audit", () => {
    const panel = buildFastOrderIntentReviewPanel({
      generatedAt: "2026-05-24T07:01:00.000Z",
      status: "paper_execution_recorded",
      decision: "approve_paper",
      intentId: "20260524070000000-capital-TX00-buy",
      ticket: {
        provider: "capital",
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      paperExecution: {
        recorded: true,
        paperOnly: true,
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      audit: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["broker-command-disabled"],
        reason: "Telegram approve 只登錄 paper execution audit；broker write path remains locked.",
      },
      writeTargets: {
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
        latestPaperExecution:
          "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
      },
      nextSafeTask: "檢查 paper execution audit。",
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("快速進出場審核結果");
    expect(text).toContain("paper_execution_recorded");
    expect(text).toContain("approve_paper");
    expect(text).toContain("模擬執行");
    expect(text).toContain("paperOnly=✅");
    expect(text).toContain("sentBrokerOrder=❌");
    expect(text).toContain("brokerCommandEnabled=❌");
    expect(text).toContain("submissionCommand=(empty)");
    expect(text).toContain("openclaw-telegram-fast-order-paper-execution-latest.json");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
  });

  it("renders fast order audit trail with latest intent, review, and paper execution", () => {
    const panel = buildFastOrderAuditTrailPanel({
      generatedAt: "2026-05-24T07:03:00.000Z",
      status: "loaded",
      safety: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      latestIntent: {
        status: "written_broker_locked",
        intentId: "20260524070000000-capital-TX00-buy",
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        blockers: ["broker-command-disabled"],
        ticket: {
          provider: "capital",
          symbol: "TX00",
          side: "buy",
          quantity: 1,
        },
      },
      latestReview: {
        status: "paper_execution_recorded",
        decision: "approve_paper",
        intentId: "20260524070000000-capital-TX00-buy",
        audit: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
          blockers: ["broker-command-disabled"],
          reason:
            "Telegram approve 只登錄 paper execution audit；broker write path remains locked.",
        },
      },
      latestPaperExecution: {
        recorded: true,
        paperOnly: true,
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
      },
      fastOrderPaperPattern: {
        pattern: "paper-success",
        successCount: 1,
        failureCount: 0,
        latestStatus: "paper_execution_recorded",
        latestSymbol: "TX00",
        latestSide: "buy",
        latestQuantity: 1,
      },
      learningSnapshotRefresh: {
        status: "refreshed",
        assistantFastOrderPaperPattern: "paper-success",
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
        snapshotPath: ".openclaw/ui/auto-trading-learning-snapshot.json",
      },
      readTargets: {
        latestIntent: "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
        latestPaperExecution:
          "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
        reviewsJsonl: ".openclaw/trading/telegram-fast-order-review-decisions.jsonl",
      },
      history: {
        filter: "all",
        offset: 0,
        limit: 5,
        total: 2,
        returned: 2,
        hasPrevious: false,
        hasNext: false,
        entries: [
          {
            kind: "paper_execution",
            generatedAt: "2026-05-24T07:01:00.000Z",
            intentId: "20260524070000000-capital-TX00-buy",
            status: "paper_execution_recorded",
            decision: "approve_paper",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
          {
            kind: "review",
            generatedAt: "2026-05-24T07:01:00.000Z",
            intentId: "20260524070000000-capital-TX00-buy",
            status: "paper_execution_recorded",
            decision: "approve_paper",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
        ],
      },
      nextSafeTask: "依最新審核紀錄決定是否重新寫入審核票。",
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("快速進出場審核紀錄");
    expect(text).toContain("loaded");
    expect(text).toContain("最新審核票");
    expect(text).toContain("written_broker_locked");
    expect(text).toContain("最新審核決策");
    expect(text).toContain("paper_execution_recorded");
    expect(text).toContain("approve_paper");
    expect(text).toContain("最新模擬執行");
    expect(text).toContain("快速進出場模擬模式");
    expect(text).toContain("學習模式: 成功=1 失敗=0");
    expect(text).toContain("模式=<code>paper-success</code>");
    expect(text).toContain("學習快照");
    expect(text).toContain("status=<code>refreshed</code>");
    expect(text).toContain("pattern=<code>paper-success</code>");
    expect(text).toContain(".openclaw/ui/auto-trading-learning-snapshot.json");
    expect(text).toContain("paperOnly=✅");
    expect(text).toContain("sentBrokerOrder=❌");
    expect(text).toContain("brokerCommandEnabled=❌");
    expect(text).toContain("submissionCommand=(empty)");
    expect(text).toContain("openclaw-telegram-fast-order-paper-execution-latest.json");
    expect(text).toContain("最近審核 / 模擬歷史");
    expect(text).toContain("filter=<code>all</code>");
    expect(text).toContain("paper_execution");
    expect(text).toContain(".openclaw/trading/telegram-fast-order-review-decisions.jsonl");
    expect(getButtonValues(panel)).toContain("sc:tr:audit");
    expect(getButtonValues(panel)).toContain("sc:tr:audit:paper_0");
    expect(getButtonValues(panel)).toContain("sc:tr:audit:denied_0");
    expect(getButtonValues(panel)).toContain("sc:tr:audit:all_5");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
    expect(getButtonValues(panel)).toContain("sc:tr:auto");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));
    expect(labels).toContain("模擬單");
    expect(labels).toContain("拒絕");
    expect(labels).not.toContain("Paper");
    expect(labels).not.toContain("Deny");
  });

  it("renders fast order audit summary on trading home without broker writes", () => {
    const panel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
      auditSummary: {
        status: "loaded",
        latestIntent: {
          status: "written_broker_locked",
          intentId: "20260524070000000-capital-TX00-buy",
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          blockers: ["broker-command-disabled"],
        },
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
          intentId: "20260524070000000-capital-TX00-buy",
          audit: {
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
            blockers: ["broker-command-disabled"],
          },
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          symbol: "TX00",
          side: "buy",
          quantity: 1,
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
        },
        history: {
          filter: "all",
          total: 3,
          returned: 3,
          entries: [
            {
              kind: "paper_execution",
              status: "paper_execution_recorded",
              decision: "approve_paper",
            },
            { kind: "review", status: "denied", decision: "deny" },
          ],
        },
        safety: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
        },
      },
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("快速進出場審核摘要");
    expect(text).toContain("paper_execution_recorded");
    expect(text).toContain("approve_paper");
    expect(text).toContain("阻擋=✅");
    expect(text).toContain("歷史 總筆=3 回傳=3");
    expect(text).toContain("學習模式: 成功=1 失敗=1");
    expect(text).toContain("模式=<code>mixed-paper-pattern</code>");
    expect(text).toContain("券商指令可用=❌");
    expect(text).toContain("已送券商單=❌");
    expect(text).toContain("送單指令=(empty)");
    expect(getButtonValues(panel)).toContain("sc:tr:audit");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
    expect(getButtonValues(panel)).toContain("sc:tr:auto");
    expect(getButtonValues(panel)).toContain("sc:tr:write");
    expect(getButtonValues(panel)).toContain("sc:tr:approve");
    expect(getButtonValues(panel)).toContain("sc:tr:deny");
  });

  it("renders shortcut gate paper-loop learning refresh sync on trading home", () => {
    const panel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
      shortcutGateSummary: buildShortcutGateSummaryFixture(),
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("Telegram 快捷 Gate");
    expect(text).toContain("status=<code>pass</code> checks=192 failed=0");
    expect(text).toContain(
      "checkCount=<code>shortcutChecks=192 failed=0 assistantClosure=42 okxClosure=18 fixtureCoverage=4 reportMachine=12 growthReason=assistant+okx+fixture+report-machine</code>",
    );
    expect(text).toContain(
      "fixtureCoverage=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
    );
    expect(text).toContain("paperLoop=✅ assistant=✅ brokerLocked=✅");
    expect(text).toContain(
      "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain(
      "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> brokerLocked=✅",
    );
    expect(text).toContain("updated=2026-05-24T14:55:47.578Z");
  });

  it("renders next-command short row from report fixture contract", () => {
    const shortcutGateSummary = buildShortcutGateSummaryFixture();
    const assistantLearningHint = (
      shortcutGateSummary.summary as {
        assistantClosure: {
          assistantLearningHint: {
            nextSafeCommand: string;
            quickLinksMatchPassedChecks: boolean;
            nextCommandShortRow: {
              command: string;
              gateVerified: boolean;
              buttons: string[];
              machineLine: string;
            };
          };
        };
      }
    ).assistantClosure.assistantLearningHint;

    assistantLearningHint.nextSafeCommand = "DRIFTED sc:tr:live";
    assistantLearningHint.quickLinksMatchPassedChecks = false;
    assistantLearningHint.nextCommandShortRow = {
      command: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
      gateVerified: true,
      buttons: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
      machineLine:
        "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
    };

    const tradingHome = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
      shortcutGateSummary,
    });
    const learningPanel = buildLearningSummaryPanel(
      "策略學習摘要：維持 paper-only。",
      null,
      shortcutGateSummary,
    );
    const text = `${getTextBlocksText(tradingHome)}\n${getTextBlocksText(learningPanel)}`;

    expect(text).toContain(
      "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain(
      "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> brokerLocked=✅",
    );
    expect(text).toContain(
      "gateHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> note=下一步指令已由 gate 驗證 brokerLocked=✅",
    );
    expect(text).not.toContain("DRIFTED sc:tr:live");
  });

  it("renders paper assistant decision gates without enabling broker writes", () => {
    const panel = buildCapitalPaperAssistantPanel({
      generatedAt: "2026-05-24T05:13:43.406Z",
      status: "blocked_quote_stale",
      ready: false,
      readOnlyQuoteOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      badge: { label: "報價過期 STALE" },
      assistant: {
        name: "類高頻自動交易助手",
        operatorAction: "等待新的 SKQuoteLib quote callback；不要登入。",
      },
      execution: {
        paperIntentCreated: false,
        entry: { side: "buy", action: "wait_for_fresh_quote", ready: false, price: 424.36 },
        exit: { side: "sell", action: "wait_for_fresh_quote", ready: false, price: 424.42 },
      },
      quote: {
        status: "stale",
        freshnessStatus: "stale",
        freshnessAgeSeconds: 88,
        latestStock: "TX00AM",
        diagnostics: { blockers: ["freshness_stale"] },
      },
      chartStrategy: {
        status: "ready_waiting_fresh_quote",
        chartData: { ready: true },
        strategyBook: { ready: true, strategyCount: 17, enabledStrategyCount: 17 },
        simulation: { status: "pass", paperIntentCount: 57, realQuoteVerified: false },
        safety: { brokerWriteLocked: true, liveOrderAllowed: false },
      },
      flowDecision: {
        decisionCode: "wait_for_quote_callback",
        action: "wait_for_fresh_quote",
        readyForPaperCycle: false,
        liveOrderAllowed: false,
        gates: [
          { id: "quote_freshness", status: "blocked", evidence: { blockers: ["freshness_stale"] } },
          { id: "chart_strategy", status: "pass" },
          { id: "strategy_learning", status: "blocked" },
          { id: "pre_trade_risk_gate", status: "pass" },
          { id: "live_promotion", status: "blocked" },
        ],
      },
      loop: { status: "blocked_readiness" },
      learning: { status: "blocked", paperEligible: false, liveEligible: false },
      fastOrderPaperPattern: {
        pattern: "paper-success",
        successCount: 2,
        failureCount: 0,
        latestStatus: "paper_execution_recorded",
        latestSymbol: "TX00",
        latestSide: "buy",
        latestQuantity: 1,
      },
      telegramPaperLoopLearningRefresh: {
        status: "refreshed",
        assistantFastOrderPaperPattern: "paper-success",
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
        snapshotPath: ".openclaw/ui/auto-trading-learning-snapshot.json",
      },
      promotion: { status: "passed" },
      cron: { status: "passed" },
      tick: { status: "monitor_fresh_realtime_stale" },
      recommendation: {
        nextSafeTask: "等待 CapitalHftService 寫入更新的 quote event；不要登入。",
      },
      shortcutGateSummary: buildShortcutGateSummaryFixture("2026-05-24T15:52:47.595Z"),
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("類高頻自動交易助手");
    expect(text).toContain("blocked_quote_stale");
    expect(text).toContain("wait_for_quote_callback");
    expect(text).toContain("freshness_stale");
    expect(text).toContain("狀態: <code>blocked_quote_stale</code> 就緒=❌");
    expect(text).toContain("快速狀態");
    expect(text).toContain(
      "學習=<code>blocked</code> 審核=<code>paper_execution_recorded/paper-success 2-0</code> 閉環=<code>refreshed</code>",
    );
    expect(text).toContain(
      "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
    );
    expect(text).toContain(
      "checkCountClosure=<code>shortcutChecks=192 failed=0 assistantClosure=42 okxClosure=18 fixtureCoverage=4 reportMachine=12 growthReason=assistant+okx+fixture+report-machine</code>",
    );
    expect(text).toContain(
      "okxHeartbeatTokenCounts=<code>messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1</code> noOrderWrite=✅",
    );
    expect(text).toContain(
      "capitalHighConfidence=<code>highConfidencePaperRerun=high_confidence_rerun_completed_still_blocked;threshold=0.6;requiredConfidence=1.306666;candidates=CD0000|YM0000|ES0000|GC0000|NQ0000;pass=0;blocked=5;noOrderWrite=true</code> requiredConfidenceStatus=<code>impossible_under_current_signal_model</code> pass=<code>0</code> blocked=<code>5</code> noOrderWrite=✅",
    );
    expect(text).toContain(
      "capitalPosition=<code>capitalVerifiedPositionSnapshot=stale_operator_refresh_required;decision=verified_flat_no_exit_required;freshness=stale;age=44623;maxFresh=43200;hasOpenPosition=false;net=0;path=D:\\OpenClaw\\config\\capital-verified-position-snapshot.json;next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check;noOrderWrite=true</code> positionFreshness=<code>stale</code> decision=<code>verified_flat_no_exit_required</code> age=<code>44623/43200</code> noOrderWrite=✅",
    );
    expect(text).toContain(
      "okxPaperAuditClosure=<code>okxPaperAudit=pass platform=read+visible okxstat=read+visible report=reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxCurrentReadinessClosure=<code>okxCurrentReadiness=ready okx=read+visible assist=read+visible report=reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json freshness=ok noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxRefreshWorkflow=<code>okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxRefreshSteps=<code>7/7</code> failedSteps=無 latestRefreshRun=<code>skipped_not_needed/null</code> noOrderWrite=✅",
    );
    expect(text).toContain(
      "okxCurrentReadinessHeartbeatOperationClosure=<code>okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxHeartbeatNext=<code>OKX current-readiness 已 ready；維持 heartbeat 監看，必要時從 sc:tr:okxrefresh 觸發安全刷新。</code>",
    );
    expect(text).toContain(
      "okxHeartbeatRefresh=<code>sc:tr:okxrefresh / pnpm okx:current-readiness:refresh</code> oneClick=✅ executeRequired=❌ noOrderWrite=✅",
    );
    expect(text).toContain("okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>");
    expect(text).toContain(
      "okxHeartbeatInventory=<code>ready / okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true</code> ready=✅ noOrderWrite=✅",
    );
    expect(text).toContain(
      "okxHeartbeatPublishBridge=<code>publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1</code> ready=✅ upstreamNoOrderWriteVerified=✅ upstreamOkxContractVerified=✅ upstreamDmadGateVerified=✅ noOrderWriteCount=<code>4</code> executeRequiredCount=<code>1</code> okxContractCount=<code>1</code> dmadGateCount=<code>1</code>",
    );
    expect(text).toContain(
      "重跑=<code>blocked_quote_stale/ready_waiting_fresh_quote/pass</code> 更新=<code>2026-05-24T05:13:43.406Z</code>",
    );
    expect(text).toContain(
      "代碼=<code>wait_for_quote_callback</code> 動作=<code>wait_for_fresh_quote</code>",
    );
    expect(text).toContain("阻擋: 新鮮度過期（<code>freshness_stale</code>）");
    expect(text).toContain("模擬循環=❌ 實單下單=❌");
    expect(text).toContain("TX00AM 時效 88s 新鮮度 <code>stale</code>");
    expect(text).toContain("僅報價=✅ 登入=❌ 實單=❌");
    expect(text).toContain("寫入=❌ 券商路徑=❌ Broker 寫入鎖=✅");
    expect(text).toContain("Broker 寫入鎖=✅");
    expect(text).toContain("chart_strategy");
    expect(text).toContain("圖表策略 <code>chart_strategy</code>");
    expect(text).toContain("圖表=✅ 策略書=✅");
    expect(text).toContain("策略 17/17 | 模擬=<code>pass</code> 模擬意圖 57");
    expect(text).toContain("進場 buy: <code>wait_for_fresh_quote</code> 就緒=❌ 價格=424.36");
    expect(text).toContain("出場 sell: <code>wait_for_fresh_quote</code> 就緒=❌ 價格=424.42");
    expect(text).toContain("strategy_learning");
    expect(text).toContain("策略學習 <code>strategy_learning</code>");
    expect(text).toContain("pre_trade_risk_gate");
    expect(text).toContain("下單前風險閘門 <code>pre_trade_risk_gate</code>");
    expect(text).toContain("live_promotion");
    expect(text).toContain("實單升級 <code>live_promotion</code>");
    expect(text).toContain(
      "循環=<code>blocked_readiness</code> 學習=<code>blocked</code> 模擬=❌ 實單=❌",
    );
    expect(text).toContain(
      "升級=<code>passed</code> 排程=<code>passed</code> 輪詢=<code>monitor_fresh_realtime_stale</code>",
    );
    expect(text).toContain("快速進出場模擬模式");
    expect(text).toContain("學習模式: 成功=2 失敗=0");
    expect(text).toContain("模式=<code>paper-success</code>");
    expect(text).toContain("Telegram 模擬閉環");
    expect(text).toContain("status=<code>refreshed</code>");
    expect(text).toContain("pattern=<code>paper-success</code>");
    expect(text).toContain("brokerCommandEnabled=❌ sentBrokerOrder=❌ submissionCommand=(empty)");
    expect(text).toContain(".openclaw/ui/auto-trading-learning-snapshot.json");
    expect(text).toContain("nextSafeCommand=<code>sc:tr:learn / sc:tr:audit</code>");
    expect(text).toContain(
      "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain(
      "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain("gateVerified=✅");
    expect(text).toContain("verified=sc:tr:assist / sc:tr:audit / sc:tr:paperloop");
    expect(text).toContain(
      "gateHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> note=下一步指令已由 gate 驗證 brokerLocked=✅",
    );
    expect(text).toContain("新的 fresh quote 後才重跑 sc:tr:paperloop");
    expect(text).toContain("brokerLocked=✅");
    expect(getButtonValues(panel)).toContain("sc:tr:assist");
    expect(getButtonValues(panel)).toContain("sc:tr:rerun");
    expect(getButtonValues(panel)).toContain("sc:tr:learn");
    expect(getButtonValues(panel)).toContain("sc:tr:audit");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
  });

  it("renders OKX refresh workflow failed steps in assistant status strip", () => {
    const shortcutGateSummary = buildShortcutGateSummaryFixture("2026-05-24T16:26:18.142Z");
    const summary = shortcutGateSummary.summary as Record<string, Record<string, unknown>>;
    summary.okxCurrentReadinessRefreshWorkflowClosure = {
      status: "blocked_read_only",
      code: "okx_current_readiness_refresh_blocked",
      callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
      totalSteps: 7,
      passedSteps: 5,
      failedSteps: ["telegram_shortcuts", "current_readiness_summary"],
      latestRefreshRunStatus: "fail",
      latestRefreshRunExitCode: 1,
      noOrderWrite: true,
      reportPath:
        "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
      machineLine:
        "okxCurrentReadinessRefresh=fail steps=5/7 freshness=stale schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true",
    };

    const panel = buildCapitalPaperAssistantPanel({
      status: "blocked_quote_stale",
      shortcutGateSummary,
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain(
      "okxRefreshWorkflow=<code>okxCurrentReadinessRefresh=fail steps=5/7 freshness=stale schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxRefreshSteps=<code>5/7</code> failedSteps=telegram_shortcuts / current_readiness_summary latestRefreshRun=<code>fail/1</code> noOrderWrite=✅",
    );
  });

  it("renders write failure classification in assistant status strip", () => {
    const panel = buildCapitalPaperAssistantPanel({
      status: "gateway_unreachable",
      ready: false,
      learning: { status: "blocked", paperEligible: false, liveEligible: false },
      loop: { status: "blocked" },
      fastOrderPaperPattern: {
        latestStatus: "gateway_unreachable",
        pattern: "gateway-failed",
        successCount: 0,
        failureCount: 1,
      },
      telegramPaperLoopLearningRefresh: {
        status: "gateway_unreachable",
        blockers: ["gateway:no-response"],
        errorDetail: "Call to 'trading.fastOrderIntent.write' failed: ETIMEDOUT",
        submissionCommand: "",
      },
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("寫入故障=<code>gateway_unreachable/gateway_not_ready</code>");
    expect(text).toContain("對策=<code>先按 sc:tr:live 檢查 Gateway，再按 sc:tr:write 重試</code>");
  });

  it("renders OKX heartbeat refresh availability in assistant status strip", () => {
    const shortcutGateSummary = buildShortcutGateSummaryFixture("2026-05-25T01:45:12.284Z");
    const summary = shortcutGateSummary.summary as Record<string, Record<string, unknown>>;
    summary.okxCurrentReadinessHeartbeatOperationClosure = {
      status: "refresh_available_read_only",
      code: "okx_current_readiness_heartbeat_refresh_available",
      callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
      telegramCallback: "sc:tr:okxrefresh",
      refreshCommand: "pnpm okx:current-readiness:refresh",
      heartbeatCommand: "pnpm okx:current-readiness:heartbeat",
      executeCommand: "pnpm okx:current-readiness:heartbeat:execute",
      oneClickRefresh: true,
      executeRequired: true,
      noOrderWrite: true,
      inventoryProbeStatus: "ready",
      inventoryProbeReady: true,
      inventoryProbeNoOrderWrite: true,
      inventoryProbeMachineLine:
        "okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true",
      publishBridgeStatusReady: true,
      publishBridgeMachineLine:
        "publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1",
      upstreamNoOrderWriteVerified: true,
      upstreamOkxContractVerified: true,
      upstreamDmadGateVerified: true,
      upstreamNoOrderWriteCount: 4,
      upstreamExecuteRequiredCount: 1,
      upstreamOkxContractCount: 1,
      upstreamDmadGateCount: 1,
      schedulerNextRunAt: "2026-05-24T20:15:00.000Z",
      nextSafeTask:
        "OKX current-readiness 偵測 stale/blocker；使用 sc:tr:okxrefresh 執行安全刷新。",
      reportPath:
        "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
      machineLine:
        "okxCurrentReadinessHeartbeat=refresh_available current=blocked refresh=available telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true",
    };

    const panel = buildCapitalPaperAssistantPanel({
      status: "blocked_quote_stale",
      shortcutGateSummary,
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain(
      "okxCurrentReadinessHeartbeatOperationClosure=<code>okxCurrentReadinessHeartbeat=refresh_available current=blocked refresh=available telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true</code>",
    );
    expect(text).toContain(
      "okxHeartbeatNext=<code>OKX current-readiness 偵測 stale/blocker；使用 sc:tr:okxrefresh 執行安全刷新。</code>",
    );
    expect(text).toContain(
      "okxHeartbeatRefresh=<code>sc:tr:okxrefresh / pnpm okx:current-readiness:refresh</code> oneClick=✅ executeRequired=✅ noOrderWrite=✅",
    );
    expect(text).toContain("okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>");
    expect(text).toContain(
      "okxHeartbeatInventory=<code>ready / okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true</code> ready=✅ noOrderWrite=✅",
    );
    expect(text).toContain(
      "okxHeartbeatPublishBridge=<code>publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1</code> ready=✅ upstreamNoOrderWriteVerified=✅ upstreamOkxContractVerified=✅ upstreamDmadGateVerified=✅ noOrderWriteCount=<code>4</code> executeRequiredCount=<code>1</code> okxContractCount=<code>1</code> dmadGateCount=<code>1</code>",
    );
    expect(text).toContain(
      "okxHeartbeatTokenCounts=<code>messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1</code> noOrderWrite=✅",
    );
  });

  it("uses Chinese fallback labels in paper assistant summary", () => {
    const panel = buildCapitalPaperAssistantPanel({});
    const text = getTextBlocksText(panel);

    expect(text).toContain("狀態: <code>未知</code>");
    expect(text).toContain("代碼=<code>未知</code> 動作=<code>未知</code>");
    expect(text).toContain("新鮮度 <code>未知</code>");
    expect(text).toContain("循環=<code>未知</code> 學習=<code>未知</code>");
    expect(text).not.toContain("<code>unknown</code>");
  });

  it("uses Chinese none fallback labels in strategy blocker snapshot", () => {
    const panel = buildStrategyPanel({
      paperLoop: "blocked",
      quoteGateStatus: "stale",
      quoteBlockedCount: 1,
      learningStatus: "blocked",
      fullChainStatus: "blocked",
      livePromotionStatus: "blocked",
    });
    const text = getTextBlocksText(panel);

    expect(text).toContain("原因 <code>無</code>");
    expect(text).toContain("| <code>無</code>");
  });

  it("escapes learning summary html content", () => {
    const panel = buildLearningSummaryPanel("<b>unsafe</b>&content");
    const text = getTextBlocksText(panel);
    expect(text).toContain("&lt;b&gt;unsafe&lt;/b&gt;&amp;content");
  });

  it("renders learning summary with fast order paper pattern", () => {
    const panel = buildLearningSummaryPanel(
      "策略學習摘要：維持 paper-only。",
      {
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          symbol: "TX00",
          side: "buy",
          quantity: 1,
        },
        history: {
          entries: [
            {
              kind: "paper_execution",
              status: "paper_execution_recorded",
              decision: "approve_paper",
            },
            { kind: "review", status: "denied", decision: "deny" },
          ],
        },
      },
      buildShortcutGateSummaryFixture("2026-05-24T16:04:18.142Z"),
    );
    const text = getTextBlocksText(panel);

    expect(text).toContain("策略學習摘要：維持 paper-only。");
    expect(text).toContain("快速進出場模擬模式");
    expect(text).toContain("學習模式: 成功=1 失敗=1");
    expect(text).toContain("模式=<code>mixed-paper-pattern</code>");
    expect(text).toContain("brokerCommandEnabled=❌ sentBrokerOrder=❌");
    expect(text).toContain("下一步指令");
    expect(text).toContain(
      "nextSafeCommand=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain("gateVerified=✅");
    expect(text).toContain("verified=sc:tr:assist / sc:tr:audit / sc:tr:paperloop");
    expect(text).toContain(
      "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
    expect(text).toContain("下一步指令已由 gate 驗證");
    expect(text).toContain("新的 fresh quote 後才重跑 sc:tr:paperloop");
    expect(text).toContain("brokerLocked=✅");
    expect(getButtonValues(panel)).toContain("sc:tr:paperloop");
    expect(getButtonValues(panel)).toContain("sc:tr:audit");
    expect(getButtonValues(panel)).toContain("sc:tr:assist");
  });

  it("keeps callback values within telegram 64-byte limit", () => {
    const state: TradingState = {
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    };
    const tradingPanel = buildTradingPanel(state);
    const platformPanel = buildAiTradingPlatformPanel(null);
    const writePanel = buildFastOrderIntentWritePanel(null);
    const reviewPanel = buildFastOrderIntentReviewPanel(null);
    const quotePanel = buildQuoteDetailPanel([]);
    const stratPanel = buildStrategyPanel({ paperLoop: "running" });
    const assistantPanel = buildCapitalPaperAssistantPanel(null);
    const learningPanel = buildLearningSummaryPanel(null);
    for (const value of [
      ...getButtonValues(tradingPanel),
      ...getButtonValues(platformPanel),
      ...getButtonValues(writePanel),
      ...getButtonValues(reviewPanel),
      ...getButtonValues(quotePanel),
      ...getButtonValues(stratPanel),
      ...getButtonValues(assistantPanel),
      ...getButtonValues(learningPanel),
    ]) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("uses Chinese copy on trading-facing text", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [
        {
          symbol: "TX00",
          side: "long",
          qty: 1,
          entryPrice: 100,
          currentPrice: 120,
          pnl: 20,
          pnlPercent: 20,
        },
      ],
      quotes: [
        {
          symbol: "TX00",
          name: "台指期",
          price: 120,
          change: 2,
          changePercent: 1.2,
          volume: 100,
          updatedAt: Date.now() - 1000,
          fresh: true,
        },
      ],
      blockers: [],
    });
    const quotePanel = buildQuoteDetailPanel([
      {
        symbol: "2330",
        name: "台積電",
        price: 999,
        change: 1,
        changePercent: 0.1,
        volume: 1000,
        updatedAt: Date.now() - 1000,
        fresh: true,
      },
    ]);
    const strategyPanel = buildStrategyPanel({ paperLoop: "running", totalTrades: 3 });

    const mergedText = [
      getTextBlocksText(tradingPanel),
      getTextBlocksText(quotePanel),
      getTextBlocksText(strategyPanel),
    ].join("\n");

    expect(mergedText).toContain("合計損益");
    expect(mergedText).toContain("模擬循環");
    expect(mergedText).toContain("秒前");
    expect(mergedText).not.toContain("P&L");
    expect(mergedText).not.toContain("Paper Loop");
    expect(mergedText).not.toContain("N/A");
  });

  it("uses consistent refresh and return button wording across trading panels", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const paperPanel = buildPaperOrderPanel();
    const quotePanel = buildQuoteDetailPanel([]);
    const strategyPanel = buildStrategyPanel({ paperLoop: "running" });
    const assistantPanel = buildCapitalPaperAssistantPanel(null);
    const learningPanel = buildLearningSummaryPanel(null);

    const labels = [
      ...tradingPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...paperPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...quotePanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...strategyPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...assistantPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...learningPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
    ];

    expect(labels).toContain("🔄 刷新");
    expect(labels).toContain(TRADING_BUTTON_COPY.rerunChecks);
    expect(labels).toContain("← 返回交易");
    expect(labels).not.toContain("🔄 重試");
    expect(labels).not.toContain("← 交易");
  });

  it("reuses shared trading copy for primary trading actions", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const paperPanel = buildPaperOrderPanel();
    const writePanel = buildFastOrderIntentWritePanel({
      status: "written_broker_locked",
      intentId: "test-intent",
      ticket: { brokerCommandEnabled: false, submissionCommand: "" },
      brokerCommandEnabled: false,
      submissionCommand: "",
      sentBrokerOrder: false,
    });

    const labels = [
      ...tradingPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...paperPanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
      ...writePanel.blocks
        .filter((block) => block.type === "buttons")
        .flatMap((block) => block.buttons.map((btn) => btn.label)),
    ];

    expect(labels).toContain(TRADING_BUTTON_COPY.quoteRefresh);
    expect(labels).toContain(TRADING_BUTTON_COPY.positionDetail);
    expect(labels).toContain(TRADING_BUTTON_COPY.aiPlatform);
    expect(labels).toContain(TRADING_BUTTON_COPY.paperOrder);
    expect(labels).toContain(TRADING_BUTTON_COPY.strategyStatus);
    expect(labels).toContain(TRADING_BUTTON_COPY.learningSummary);
    expect(labels).toContain(TRADING_BUTTON_COPY.diagnose);
    expect(labels).toContain(TRADING_BUTTON_COPY.capitalStatus);
    expect(labels).toContain(TRADING_BUTTON_COPY.hftGates);
    expect(labels).toContain(TRADING_BUTTON_COPY.dispatcherCheck);
    expect(labels).toContain(TRADING_BUTTON_COPY.okxStatus);
    expect(labels).toContain(TRADING_BUTTON_COPY.okxOrderProposal);
    expect(labels).toContain(TRADING_BUTTON_COPY.okxOrderStatus);
    expect(labels).toContain(TRADING_BUTTON_COPY.liveBlockers);
    expect(labels).toContain(TRADING_BUTTON_COPY.paperAssistant);
    expect(labels).toContain(TRADING_BUTTON_COPY.writeFastTicket);
    expect(labels).toContain(TRADING_BUTTON_COPY.approvePaper);
    expect(labels).toContain(TRADING_BUTTON_COPY.paperReviewLoop);
    expect(labels).toContain(TRADING_BUTTON_COPY.tradeAutoCycle);
    expect(labels).toContain(TRADING_BUTTON_COPY.denyFastTicket);
    expect(labels).toContain(TRADING_BUTTON_COPY.auditTrail);
    expect(labels).toContain(TRADING_BUTTON_COPY.buy);
    expect(labels).toContain(TRADING_BUTTON_COPY.sell);
    expect(labels).toContain(TRADING_BUTTON_COPY.closeAll);
    expect(labels).toContain(TRADING_BUTTON_COPY.home);
    expect(labels).not.toContain("Buy");
    expect(labels).not.toContain("Sell");
    expect(labels.some((label) => label.includes("Paper"))).toBe(false);
    expect(labels.some((label) => label.includes("HFT"))).toBe(false);
    expect(labels).not.toContain("Dashboard");
  });

  it("uses Chinese recovery guidance in empty quote state", () => {
    const quotePanel = buildQuoteDetailPanel([]);
    const text = getTextBlocksText(quotePanel);

    expect(text).toContain("報價狀態：<b>斷線</b>");
    expect(text).toContain("交易診斷");
    expect(text).toContain("模擬助手");
    expect(text).not.toContain("Paper 助手");
    expect(text).not.toContain("BrokerDesk");
  });

  it("does not contain BrokerDesk wording across trading-facing panels", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [
        {
          symbol: "TX00",
          name: "台指期",
          price: 120,
          change: 2,
          changePercent: 1.2,
          volume: 100,
          updatedAt: Date.now() - 1000,
          fresh: true,
        },
      ],
      blockers: [],
    });
    const quotePanel = buildQuoteDetailPanel([]);
    const platformPanel = buildAiTradingPlatformPanel(null);
    const strategyPanel = buildStrategyPanel({ paperLoop: "running", totalTrades: 3 });
    const learningPanel = buildLearningSummaryPanel("測試摘要");

    const mergedText = [
      getTextBlocksText(tradingPanel),
      getTextBlocksText(quotePanel),
      getTextBlocksText(platformPanel),
      getTextBlocksText(strategyPanel),
      getTextBlocksText(learningPanel),
    ].join("\n");

    expect(mergedText).not.toContain("BrokerDesk");
  });

  it("renders Capital service status with quote, query, order, and safety gates", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const capitalPanel = buildCapitalServiceStatusPanel({
      generatedAt: "2026-05-23T05:21:16.618Z",
      status: "blocked_or_degraded",
      ready: false,
      blockerCode: "capital_watchdog_not_ready",
      failedSteps: ["watchdog_ready<danger>&"],
      capitalRoot: "D:\\群益及元大API\\CapitalHftService",
      readOnly: true,
      loginAttempted: false,
      service: {
        status: "http",
        pid: 44228,
        ready: true,
        livenessStatus: "alive",
        loginStatus: "connected",
        quoteMonitorConnected: true,
        orderInitialized: true,
      },
      quote: {
        ready: true,
        status: "fresh",
        freshnessAgeSeconds: 60,
        callbackReportableCount: 2,
        callbackFreshMatchedCount: 2,
      },
      positionQuery: { ready: true, accountCount: 2 },
      paperTrading: { ready: true },
      liveOrders: { ready: false, reason: "allowLiveTrading_false" },
      watchdog: { ready: false, blockerCode: "market_session_closed" },
      orderMode: { ready: true, status: "pass" },
      safety: {
        sentOrder: false,
        allowLiveTrading: false,
        writeBrokerOrders: false,
        realOrderAllowed: false,
      },
      telegramPoller: { summary: "send-only:openclaw_gateway" },
      nextSafeTask: "先修復 watchdog",
      replyLine: "[OpenClaw Capital 狀態] 報價=READY｜真單=封鎖",
    });

    const tradingValues = getButtonValues(tradingPanel);
    const capitalText = getTextBlocksText(capitalPanel);

    expect(tradingValues).toContain("sc:tr:cap");
    expect(capitalText).toContain("群益 API 狀態");
    expect(capitalText).toContain("阻擋或降級");
    expect(capitalText).toContain("群益監看未就緒");
    expect(capitalText).toContain("報價");
    expect(capitalText).toContain("查詢=✅");
    expect(capitalText).toContain("真單=❌");
    expect(capitalText).toContain("已送單=❌");
    expect(capitalText).toContain("watchdog_ready&lt;danger&gt;&amp;");
    expect(getButtonValues(capitalPanel)).toContain("sc:tr:cap");
    expect(getButtonValues(capitalPanel)).toContain("sc:tr:disp");
    expect(getButtonValues(capitalPanel)).toContain("sc:trade");
  });

  it("localizes unknown/none fallback labels in capital status panel", () => {
    const panel = buildCapitalServiceStatusPanel({
      generatedAt: "2026-05-24T09:00:00.000Z",
      status: "",
      ready: false,
      blockerCode: "",
      capitalRoot: "D:\\Capital",
      service: {
        status: "",
        livenessStatus: "",
        loginStatus: "",
      },
      quote: {},
      positionQuery: {},
      paperTrading: {},
      liveOrders: {},
      watchdog: {},
      orderMode: {},
      safety: {},
      telegramPoller: {},
      failedSteps: [],
      replyLine: "",
    });
    const text = getTextBlocksText(panel);
    expect(text).toContain("狀態: <code>未知</code>");
    expect(text).toContain("阻擋: <code>無</code>");
    expect(text).toContain("原因=<code>未知</code>");
    expect(text).toContain("阻擋=<code>無</code>");
    expect(text).not.toContain("<code>unknown</code>");
    expect(text).not.toContain("<code>none</code>");
  });

  it("renders OKX gate status with escaped operational evidence", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const okxPanel = buildOkxStatusPanel({
      generatedAt: "2026-05-24T02:12:26.974Z",
      status: "read_only_demo_verified_live_blocked",
      summary_zh_tw: "OKX <demo>& live",
      blockers: ["order_not_enabled<danger>&"],
      markers: ["demo_ok", "live_401"],
      quote: { code: "quote_ok", instId: "BTC-USDT", last: "76894" },
      authentication: {
        demo: { profile: "demo", code: "demo_ok" },
        live: { profile: "main", code: "live_401" },
      },
      safety: {
        orderPlacementEnabled: false,
        liveTradingEnabled: false,
        readOnlyCommandsOnly: true,
        submittedOrder: false,
        writeTradingEnabled: false,
      },
      config: {
        localConfigExists: true,
        configMaskedOnly: true,
        profileFields: {
          main: { apiKeyPresent: true, secretKeyPresent: true, passphrasePresent: true },
          demo: { apiKeyPresent: true, secretKeyPresent: true, passphrasePresent: true },
        },
      },
      credentialPolicy: {
        chatProvidedCredentialAction: "reject_and_rotate",
        allowedPermissionSetBeforePromotion: ["read"],
        blockedPermissionSetBeforePromotion: ["trade", "withdraw"],
        ipAllowlistRequiredForTradeOrWithdraw: true,
        keyPostedInChatMustBeRevoked: true,
      },
      agentTradeKit: {
        mcpCompatible: true,
        cliCompatible: true,
        requiredProfileForAuthenticatedCommands: true,
        demoProfile: "demo",
      },
      currentReadinessSummary: {
        status: "ready_read_only",
        code: "okx_current_readiness_ready",
        machineLine:
          "okxCurrentReadiness=ready quote=ok scheduler=pass schedulerNextRunAt=2026-05-24T19:42:52.788Z demo=ready_no_exchange_write paperAudit=ready_read_only telegram=pass refresh=available freshness=ok noOrderWrite=true",
        blockers: [],
        safety: {
          noOrderWrite: true,
          readOnly: true,
          summaryOnly: true,
        },
      },
      currentReadinessRefreshWorkflow: {
        status: "ready_read_only",
        code: "okx_current_readiness_refresh_ready",
        machineLine:
          "okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok schedulerNextRunAt=2026-05-24T19:42:52.788Z noOrderWrite=true",
        steps: [
          { id: "market_snapshot", status: "pass" },
          { id: "market_snapshot_scheduler", status: "pass" },
          { id: "demo_simulation", status: "pass" },
          { id: "paper_audit_log", status: "pass" },
          { id: "paper_audit_summary", status: "pass" },
          { id: "telegram_shortcuts", status: "pass" },
          { id: "current_readiness_summary", status: "pass" },
        ],
        safety: {
          noOrderWrite: true,
          readOnly: true,
          summaryOnly: true,
        },
      },
      currentReadinessHeartbeatOperation: {
        refreshRun: {
          status: "skipped_not_needed",
          exitCode: null,
          durationMs: 0,
        },
      },
      marketSnapshotScheduler: {
        status: "passed",
        machineLine:
          "okxMarketSnapshotScheduler=pass everyMs=300000 nextRunAt=2026-05-24T19:42:52.788Z entrypoint=okx:market-snapshot noOrderWrite=true",
        schedule: {
          name: "OKX market snapshot read-only refresh",
          everyMs: 300000,
          nextRunAt: "2026-05-24T19:42:52.788Z",
          entrypoint: "pnpm okx:market-snapshot",
          checkEntrypoint: "pnpm okx:market-snapshot:check",
        },
        safety: {
          noOrderWrite: true,
          readOnly: true,
          publicMarketDataOnly: true,
          privateOrderQueryEnabled: false,
          orderPlacementEnabled: false,
          cancelOrderEnabled: false,
          liveTradingEnabled: false,
        },
        blockers: [],
      },
      nextSafeTask: "維持 demo",
    });

    const tradingValues = getButtonValues(tradingPanel);
    const okxText = getTextBlocksText(okxPanel);

    expect(tradingValues).toContain("sc:tr:okx");
    expect(okxText).toContain("OKX API 狀態");
    expect(okxText).toContain("模擬");
    expect(okxText).toContain("實盤");
    expect(okxText).toContain("交易助手工具組");
    expect(okxText).toContain("唯讀模擬已驗證且實盤阻擋");
    expect(okxText).toContain("live_401");
    expect(okxText).toContain("BTC-USDT");
    expect(okxText).toContain("OKX &lt;demo&gt;&amp; live");
    expect(okxText).toContain("order_not_enabled&lt;danger&gt;&amp;");
    expect(okxText).toContain("Key / 權限");
    expect(okxText).toContain("本機設定: ✅");
    expect(okxText).toContain("僅遮罩: ✅");
    expect(okxText).toContain("主帳 key=✅");
    expect(okxText).toContain("模擬 key=✅");
    expect(okxText).toContain("reject_and_rotate");
    expect(okxText).toContain("升版前允許權限");
    expect(okxText).toContain("read");
    expect(okxText).toContain("trade/withdraw");
    expect(okxText).toContain("交易/提領需 IP 白名單: ✅");
    expect(okxText).toContain("聊天貼出 key 必須撤銷: ✅");
    expect(okxText).toContain("OKX 當前就緒摘要");
    expect(okxText).toContain("OKX 當前就緒");
    expect(okxText).toContain(
      "okxCurrentReadiness=ready quote=ok scheduler=pass schedulerNextRunAt=2026-05-24T19:42:52.788Z demo=ready_no_exchange_write paperAudit=ready_read_only telegram=pass refresh=available freshness=ok noOrderWrite=true",
    );
    expect(okxText).toContain("pnpm okx:current-readiness:refresh");
    expect(okxText).toContain("openclaw-okx-current-readiness-summary-latest.json");
    expect(okxText).toContain("OKX 刷新流程");
    expect(okxText).toContain(
      "okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok schedulerNextRunAt=2026-05-24T19:42:52.788Z noOrderWrite=true",
    );
    expect(okxText).toContain("failedSteps=<code>無</code>");
    expect(okxText).toContain("latestRefreshRun=<code>skipped_not_needed/null</code>");
    expect(okxText).toContain("openclaw-okx-current-readiness-refresh-workflow-latest.json");
    expect(okxText).toContain("OKX 報價排程");
    expect(okxText).toContain("2026-05-24T19:42:52.788Z");
    expect(okxText).toContain(
      "okxMarketSnapshotScheduler=pass everyMs=300000 nextRunAt=2026-05-24T19:42:52.788Z entrypoint=okx:market-snapshot noOrderWrite=true",
    );
    expect(okxText).toContain("禁止下單寫入=✅");
    expect(okxText).toContain("公開行情=✅");
    expect(okxText).toContain("私有訂單=✅");
    expect(okxText).toContain("pnpm okx:market-snapshot:scheduler:check");
    expect(okxText).toContain("openclaw-okx-market-snapshot-scheduler-latest.json");
    expect(getButtonValues(okxPanel)).toContain("sc:tr:okx");
    expect(getButtonValues(okxPanel)).toContain("sc:tr:okxrefresh");
    expect(getButtonValues(okxPanel)).toContain("sc:trade");
  });

  it("renders Capital direct-operation gate without broker writes", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "stale",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const directPanel = buildCapitalDirectOperationPanel({
      generatedAt: "2026-05-25T00:13:00.051Z",
      status: "ready",
      mode: "operator_input_templates_only",
      requestedTrade: {
        instrument: "A50 202605",
        quoteSymbol: "CN0000",
        holdingMode: "day_trade",
        status: "blocked_a50_stale",
      },
      sealedIntentSha256: "ABC123",
      templates: {
        verifiedPositionSnapshot: {
          path: ".openclaw/trading/templates/capital-verified-position-snapshot.template.json",
        },
        externalBrokerAdapterAck: {
          path: ".openclaw/trading/templates/capital-external-broker-adapter-ack.template.json",
        },
        externalBrokerAdapterAckRequiredCurrent: {
          path: ".openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
        },
      },
      activeTargets: {
        verifiedPositionSnapshot: {
          path: "config/capital-verified-position-snapshot.json",
          exists: false,
          status: "missing",
          usable: false,
          verifiedAt: "2026-05-25T00:34:10.000Z",
          verifiedBy: "telegram-owner",
          verifiedAgeSeconds: 120,
          maxFreshSeconds: 43200,
          freshnessStatus: "fresh",
          stagedRefreshPath:
            ".openclaw/trading/staging/capital-verified-position-snapshot.staged-refresh.json",
        },
        externalBrokerAdapterAck: {
          path: ".openclaw/trading/capital-external-broker-adapter-ack.json",
          exists: false,
          status: "missing",
          usable: false,
          expectedSealedIntentSha256: "ABC123",
          actualSealedIntentSha256: "OLD456",
          hashOk: false,
        },
      },
      operatorSteps: [
        { id: "verified_position_snapshot", validation: "pnpm capital:trade:direct:status:check" },
        { id: "external_broker_adapter_ack", validation: "pnpm capital:trade:direct:check" },
      ],
      safety: {
        generatedTemplatesOnly: true,
        wroteActivePositionSnapshot: false,
        wroteActiveAdapterAck: false,
        brokerWriteAttempted: false,
        sentOrder: false,
        noLiveOrderSent: true,
      },
      statusReport: {
        summary: {
          quote: {
            serviceStatus: "blocked_or_degraded",
            domesticTxFreshness: "session_closed",
            a50Status: "stale",
            a50Subscribed: true,
            a50AgeSeconds: 999,
          },
          position: {
            decisionStatus: "blocked_no_verified_position_snapshot",
            usable: false,
            path: "config/capital-verified-position-snapshot.json",
            verifiedAt: "2026-05-25T00:34:10.000Z",
            verifiedBy: "telegram-owner",
            verifiedAgeSeconds: 120,
            maxFreshSeconds: 43200,
            freshnessStatus: "fresh",
            handoff: {
              status: "stale_operator_refresh_required",
              freshnessStatus: "stale",
              stagedRefreshPath:
                ".openclaw/trading/staging/capital-verified-position-snapshot.staged-refresh.json",
              nextHandoffStep: {
                id: "review_current_broker_position",
                status: "pending_operator_review",
              },
              handoffChecklist: [
                { id: "review_current_broker_position", status: "pending_operator_review" },
                {
                  id: "operator_refresh_position_snapshot",
                  status: "pending_operator_owned_position_query",
                },
                { id: "rerun_direct_status", status: "blocked_until_position_refresh" },
                { id: "rerun_live_readiness", status: "blocked_until_position_refresh" },
              ],
            },
          },
          externalBrokerAdapter: {
            ackStatus: "missing",
            ackUsable: false,
            ackPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
            applyReceipt: {
              required: true,
              reportRead: true,
              status: "pending_operator_apply",
              verified: false,
              operatorMayApply: true,
              operatorApplyVerified: false,
              action: "operator_apply_required",
              owner: "operator-owned-broker-adapter-only",
              activeState: "pre_apply_current_matches",
              sourcePath:
                ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
              destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
              validationCommand:
                "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
              postApplyClosureCommand:
                "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
              noLiveOrderSent: true,
              sentOrder: false,
              writeBrokerOrders: false,
              liveTradingEnabled: false,
              operatorHandoff: {
                status: "pending_operator_apply",
                nextAction: "operator_adapter_atomic_apply",
                allowedActor: "operator-controlled-broker-adapter",
                requiredValidation: [
                  "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
                  "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack:check",
                  "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
                ],
                brokerOrderWriteAllowed: false,
                automationMayWriteActiveAck: false,
                telegramMayWriteActiveAck: false,
                noLiveOrderSent: true,
              },
              machineLine:
                "capitalAdapterAckApplyReceipt=pending_operator_apply sha256=ABC123 operatorMayApply=true operatorApplyVerified=false noLiveOrderSent=true sentOrder=false noOrderWrite=true blockers=1",
              blockers: ["operator-apply:pending"],
              nextSafeTask:
                "operator-owned adapter must apply staged-current ack, then rerun apply receipt check.",
            },
          },
          sealedOrderIntent: { sha256: "ABC123" },
          safety: { noLiveOrderSent: true, sentOrder: false },
          blockers: ["quote_fresh_matched:session_closed", "live-risk:runtime-write-forbidden"],
        },
      },
      operatorPacketReport: {
        status: "blocked",
        operatorCanExecute: false,
        machineLine:
          "capitalOperatorPacket=blocked sha256=ABC123 readiness=blocked adapterAck=blocked operatorCanExecute=false noOrderWrite=true sentOrder=false blockers=3",
        readiness: { status: "blocked" },
        adapterAck: {
          status: "blocked",
          hashOk: false,
          canaryPass: true,
          canaryDryRun: true,
          canarySentOrder: false,
          rollbackPass: true,
          rollbackVerifiedAt: "2026-05-25T00:34:10.000Z",
          rollbackAgeSeconds: 120,
          rollbackMaxFreshSeconds: 43200,
          rollbackFresh: true,
          rollbackFreshnessStatus: "fresh",
          expectedSealedIntentSha256: "ABC123",
          actualSealedIntentSha256: "OLD456",
          requiredTemplatePath:
            ".openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
        },
        executionPayload: { dispatchPolicy: "blocked_do_not_send" },
        blockers: ["readiness:not-ready", "adapterAck:not-verified", "direct:pretrade-not-ready"],
        blockerPlan: {
          status: "blocked",
          orderedActionCount: 4,
          nextAction: "adapter_ack_hash",
          orderedActions: [
            {
              id: "adapter_ack_hash",
              status: "blocked",
              gate: "adapter:ack-usable",
              validationCommand: "pnpm capital:trade:adapter-ack:check",
            },
            {
              id: "live_executor_arm_profile",
              status: "blocked",
              gate: "executor:arm-profile-armed",
              validationCommand: "pnpm capital:trade:live-executor-profile:check",
            },
            {
              id: "direct_pretrade_clear",
              status: "blocked",
              gate: "direct:pretrade-allowed",
              validationCommand: "pnpm capital:live-order-dry-run",
            },
            {
              id: "readiness_aggregation",
              status: "blocked",
              gate: "readiness:ready-for-operator-review",
              validationCommand: "pnpm capital:live-readiness:check",
            },
          ],
        },
        safety: {
          noOrderWrite: true,
          sentOrder: false,
        },
      },
      adapterAckGateReport: {
        status: "blocked",
        operatorReview: {
          status: "staged_candidate_ready_for_operator_adapter",
          stagedCandidateAckPath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          activeVsCandidate: {
            status: "mismatch",
          },
          refreshPlan: {
            status: "operator_refresh_required",
            safeToPromoteCandidate: true,
            sourcePath:
              ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
            destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
          },
          handoffChecklist: [
            { id: "review_staged_candidate_ack", status: "pending" },
            { id: "verify_canary_dry_run", status: "complete" },
            { id: "verify_rollback_freshness", status: "complete" },
            { id: "operator_owned_active_ack_refresh", status: "pending_operator_owned_adapter" },
            { id: "rerun_live_readiness", status: "blocked_until_ack_verified" },
          ],
        },
      },
      adapterAckApplyVerifierReport: {
        status: "ready_for_operator_apply",
        applyVerdict: {
          status: "ready_for_operator_apply",
          activeState: "pre_apply_current_matches",
          operatorMayApply: true,
          operatorApplyVerified: false,
          sourcePath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
        },
      },
      adapterAckApplyPlanReport: {
        status: "ready_atomic_apply_plan",
        operatorApplyPlan: {
          status: "ready_atomic_apply_plan",
          applyAllowedByPlan: true,
          alreadyAppliedVerified: false,
          sourcePath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
        },
      },
      adapterAckApplyReceiptReport: {
        status: "pending_operator_apply",
        operatorReceipt: {
          status: "pending_operator_apply",
          action: "operator_apply_required",
          operatorMayApply: true,
          operatorApplyVerified: false,
          sourcePath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
          validationCommands: {
            receipt: "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
            postApplyClosure: "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
          },
        },
        operatorHandoff: {
          status: "pending_operator_apply",
          nextAction: "operator_adapter_atomic_apply",
          allowedActor: "operator-controlled-broker-adapter",
          sourcePath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
          requiredValidation: [
            "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
            "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack:check",
            "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
          ],
          safety: {
            brokerOrderWriteAllowed: false,
            automationMayWriteActiveAck: false,
            telegramMayWriteActiveAck: false,
            noLiveOrderSent: true,
          },
        },
      },
      postApplyClosureReport: {
        status: "blocked_post_apply_closure_incomplete",
        operatorCanExecute: false,
        adapterApply: {
          verified: false,
          verifierStatus: "ready_for_operator_apply",
          activeState: "pre_apply_current_matches",
          operatorMayApply: true,
          operatorApplyVerified: false,
        },
        applyPlan: {
          status: "ready_atomic_apply_plan",
          applyAllowedByPlan: true,
          alreadyAppliedVerified: false,
        },
        adapterApplyReceipt: {
          verified: false,
          status: "pending_operator_apply",
          action: "operator_apply_required",
          operatorMayApply: true,
          operatorApplyVerified: false,
          sourcePath:
            ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
        },
        liveReadiness: {
          status: "blocked_live_readiness_incomplete",
          operatorCanExecute: false,
        },
        localExecutorDispatch: {
          status: "blocked",
          dispatchPolicy: "blocked_do_not_send",
          operatorCanExecute: false,
        },
        validationCommands: {
          closure: "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
          applyReceipt: "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
        },
        safety: {
          noLiveOrderSent: true,
          sentOrder: false,
          writeBrokerOrders: false,
        },
        blockers: [
          "adapterAck:operator-apply-receipt-not-verified",
          "adapterAck:operator-apply-not-verified",
        ],
        machineLine:
          "capitalPostApplyClosure=blocked_post_apply_closure_incomplete adapterApplyVerified=false adapterApplyReceiptVerified=false operatorCanExecute=false noLiveOrderSent=true sentOrder=false noOrderWrite=true blockers=2",
      },
      localExecutorDispatchReport: buildLocalExecutorDispatchFixture(),
      liveExecutorArmProfileReport: buildLiveExecutorArmProfileFixture(),
      autoDeactivateReceiptGateReport: {
        schema: "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1",
        generatedAt: "2026-05-26T16:39:38.598Z",
        status: "pending_explicit_execute_receipt",
        auditId: "capital-auto-deactivate-5417f11f9d6d9e65d836",
        pendingExplicitExecuteReceipt: true,
        receiptVerified: false,
        execute: false,
        applied: false,
        operatorActionRequired: true,
        heartbeatExecuteAllowed: false,
        validationCommands: {
          receiptGate:
            "pnpm --dir D:\\OpenClaw capital:live-trading:operator:auto-deactivate:receipt:check",
        },
        blockers: ["operator-auto-deactivate:execute-receipt-pending"],
        safety: {
          reportOnly: true,
          noLiveOrderSent: true,
          sentOrder: false,
          writeBrokerOrders: false,
          liveTradingEnabled: false,
          heartbeatExecuteAllowed: false,
        },
        machineLine:
          "capitalAutoDeactivateReceipt=pending_explicit_execute_receipt audit=capital-auto-deactivate-5417f11f9d6d9e65d836 pendingExplicitExecuteReceipt=true receiptVerified=false heartbeatExecuteAllowed=false noOrderWrite=true sentOrder=false",
      },
      strategyPlatformReport: {
        liveCompletion: {
          status: "blocked",
          operatorCanExecute: false,
          dispatchPolicy: "blocked_do_not_send",
          passCount: 4,
          stageCount: 8,
          noLiveOrderSent: true,
          writeBrokerOrders: false,
          stages: [
            { id: "quote:strategy-ready", status: "pass" },
            { id: "position:verified-fresh", status: "pass" },
            { id: "strategy:paper-promoted", status: "blocked" },
            { id: "adapter:ack-hash-match", status: "blocked" },
            { id: "adapter:canary-no-order", status: "pass" },
            { id: "adapter:rollback-fresh", status: "pass" },
            { id: "direct:pretrade-clear", status: "blocked" },
            { id: "operator-packet:execution-ready", status: "blocked" },
          ],
        },
        strategy: {
          strategyTailRiskRepair: {
            status: "blocked_no_effective_repair_ready",
            selectedSymbols: ["ES0000"],
            machineLine:
              "tailRiskRepairPlan=blocked_no_effective_repair_ready candidatePlan=needs_candidate_or_outcome_evidence noOrderWrite=true",
            repairCandidatePlan: {
              status: "needs_candidate_or_outcome_evidence",
              noOrderWrite: true,
              nextPaperCandidateBatch: {
                status: "ready_to_refresh_and_rerun",
                selectedSymbols: ["YM0000", "NQ0000", "MCL0000"],
                followUpCommand: "pnpm capital:strategy:fill-simulation:check",
                sameCaseRerunEvidence: {
                  status: "ready_for_same_case_rerun",
                  followUpCommand: "pnpm capital:strategy:fill-simulation:check",
                  candidateContributionRanking: [
                    {
                      symbol: "YM0000",
                      p05DragProxyNotional: -40,
                      requiresSameCaseRerun: true,
                    },
                    {
                      symbol: "NQ0000",
                      p05DragProxyNotional: -80,
                      requiresSameCaseRerun: true,
                    },
                    {
                      symbol: "MCL0000",
                      p05DragProxyNotional: -400,
                      requiresSameCaseRerun: true,
                    },
                  ],
                  safetyLock: {
                    paperOnly: true,
                    simulatedOnly: true,
                    writeBrokerOrders: false,
                    sentOrder: false,
                  },
                },
              },
              buckets: [
                {
                  id: "fresh_resolved_low_correlation_or_opposite_exposure",
                  status: "candidate_pool_present",
                  candidateCount: 4,
                },
                {
                  id: "contract_point_value_currency_backfill",
                  status: "required",
                  candidateCount: 1,
                },
                {
                  id: "risk_notional_cap_review",
                  status: "required_before_selection",
                  candidateCount: 2,
                },
                {
                  id: "selected_signal_confidence_recheck",
                  status: "required",
                  candidateCount: 1,
                },
                {
                  id: "empirical_stop_hit_calibration",
                  status: "blocked",
                  candidateCount: 0,
                },
                {
                  id: "same_case_rerun",
                  status: "required_after_candidate_or_calibration_update",
                  candidateCount: 0,
                },
              ],
            },
          },
        },
      },
      nextSafeTask: "補齊 verified position snapshot 與 adapter ack。",
    });

    const directText = getTextBlocksText(directPanel);

    expect(getButtonValues(tradingPanel)).toContain("sc:tr:direct");
    expect(directText).toContain("直接操作 Gate");
    expect(directText).toContain("A50 202605");
    expect(directText).toContain("sealedOrderIntent.sha256");
    expect(directText).toContain("ABC123");
    expect(directText).toContain("真單解鎖三件事");
    expect(directText).toContain("verified position snapshot=❌");
    expect(directText).toContain("adapter ack required-current=❌");
    expect(directText).toContain("live executor arm profile=❌");
    expect(directText).toContain("armed=✅");
    expect(directText).toContain("allowExecutorWrite=❌");
    expect(directText).toContain("expired=✅");
    expect(directText).toContain("capital-live-executor-arm-profile.json");
    expect(directText).toContain(
      "rearmHandoff=<code>staged_rearm_candidate_ready_for_operator</code>",
    );
    expect(directText).toContain("capital-live-executor-arm-profile.staged-rearm.json");
    expect(directText).toContain(
      "allowedWriter=<code>operator-managed-local-broker-executor-only</code>",
    );
    expect(directText).toContain("activeProfileWriteSuppressed=✅");
    expect(directText).toContain("conversationMayWriteActiveProfile=❌");
    expect(directText).toContain("review_staged_rearm_profile");
    expect(directText).toContain("operator_managed_active_profile_rearm");
    expect(directText).toContain("rerun_live_readiness");
    expect(directText).toContain("缺 verified position snapshot");
    expect(directText).toContain("Broker Adapter Ack");
    expect(directText).toContain("Operator Execution Packet");
    expect(directText).toContain("operatorCanExecute=❌");
    expect(directText).toContain("dispatch=<code>blocked_do_not_send</code>");
    expect(directText).toContain("capitalOperatorPacket=blocked");
    expect(directText).toContain("nextAction=<code>adapter_ack_hash</code>");
    expect(directText).toContain("ordered=4");
    expect(directText).toContain("adapter:ack-usable");
    expect(directText).toContain("pnpm capital:trade:adapter-ack:check");
    expect(directText).toContain("live_executor_arm_profile");
    expect(directText).toContain("本地執行器 Dispatch");
    expect(directText).toContain("capitalLocalExecutorDispatch=blocked");
    expect(directText).toContain("executorArmed=❌");
    expect(directText).toContain("payloadHash=<code>PAYLOAD123</code>");
    expect(directText).toContain("回關收據 Gate");
    expect(directText).toContain("pendingExplicitExecuteReceipt=✅");
    expect(directText).toContain("receiptVerified=❌");
    expect(directText).toContain("heartbeatExecuteAllowed=❌");
    expect(directText).toContain("operator-auto-deactivate:execute-receipt-pending");
    expect(directText).toContain(
      "receiptCheck=<code>pnpm --dir D:\\OpenClaw capital:live-trading:operator:auto-deactivate:receipt:check</code>",
    );
    expect(directText).toContain("noLiveOrderSent=✅");
    expect(directText).toContain("sentOrder=❌");
    expect(directText).toContain("brokerWriteAttempted=❌");
    expect(directText).toContain("freshness=<code>fresh</code>");
    expect(directText).toContain("age=120s");
    expect(directText).toContain("verifiedAt=<code>2026-05-25T00:34:10.000Z</code>");
    expect(directText).toContain(
      "operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos / pnpm capital:trade:direct:status:check</code> noOrderWrite=✅",
    );
    expect(directText).toContain("capital-verified-position-snapshot.template.json");
    expect(directText).toContain("handoff=<code>stale_operator_refresh_required</code>");
    expect(directText).toContain("next=<code>review_current_broker_position</code>");
    expect(directText).toContain("capital-verified-position-snapshot.staged-refresh.json");
    expect(directText).toContain("operator_refresh_position_snapshot");
    expect(directText).toContain("pending_operator_owned_position_query");
    expect(directText).toContain("capital-external-broker-adapter-ack.template.json");
    expect(directText).toContain("requiredCurrent=<code>");
    expect(directText).toContain("capital-external-broker-adapter-ack.required-current.json");
    expect(directText).toContain("expectedHash=<code>ABC123</code>");
    expect(directText).toContain("activeHash=<code>OLD456</code>");
    expect(directText).toContain("hashOk=❌");
    expect(directText).toContain("canary=✅");
    expect(directText).toContain("rollback=✅");
    expect(directText).toContain("canaryNoOrder=✅");
    expect(directText).toContain("rollbackFresh=<code>fresh</code>");
    expect(directText).toContain("rollbackAge=120s");
    expect(directText).toContain(
      "handoff=<code>staged_candidate_ready_for_operator_adapter</code>",
    );
    expect(directText).toContain("activeVsCandidate=<code>mismatch</code>");
    expect(directText).toContain("refreshPlan=<code>operator_refresh_required</code>");
    expect(directText).toContain("safeToPromote=✅");
    expect(directText).toContain(
      "dest=<code>.openclaw/trading/capital-external-broker-adapter-ack.json</code>",
    );
    expect(directText).toContain("capital-external-broker-adapter-ack.staged-current.json");
    expect(directText).toContain("operator_owned_active_ack_refresh");
    expect(directText).toContain("pending_operator_owned_adapter");
    expect(directText).toContain("Adapter Post-Apply Readback");
    expect(directText).toContain("verifier=<code>ready_for_operator_apply</code>");
    expect(directText).toContain("activeState=<code>pre_apply_current_matches</code>");
    expect(directText).toContain("plan=<code>ready_atomic_apply_plan</code>");
    expect(directText).toContain("applyAllowedByPlan=✅");
    expect(directText).toContain("alreadyApplied=❌");
    expect(directText).toContain("receipt=<code>pending_operator_apply</code>");
    expect(directText).toContain("closure=<code>blocked_post_apply_closure_incomplete</code>");
    expect(directText).toContain("liveReadiness=<code>blocked_live_readiness_incomplete</code>");
    expect(directText).toContain("localDispatch=<code>blocked</code>");
    expect(directText).toContain("capitalPostApplyClosure=blocked_post_apply_closure_incomplete");
    expect(directText).toContain("adapterAck:operator-apply-receipt-not-verified");
    expect(directText).toContain("Adapter Apply Receipt");
    expect(directText).toContain("operatorMayApply=✅");
    expect(directText).toContain("operatorApplyVerified=❌");
    expect(directText).toContain("operator-owned-broker-adapter-only");
    expect(directText).toContain("operator_apply_required");
    expect(directText).toContain("pre_apply_current_matches");
    expect(directText).toContain("handoffNext=<code>operator_adapter_atomic_apply</code>");
    expect(directText).toContain("allowedActor=<code>operator-controlled-broker-adapter</code>");
    expect(directText).toContain("automationMayWriteActiveAck=❌");
    expect(directText).toContain("telegramMayWriteActiveAck=❌");
    expect(directText).toContain("brokerOrderWriteAllowed=❌");
    expect(directText).toContain("handoffValidation=");
    expect(directText).toContain("pnpm --dir D:\\OpenClaw capital:trade:adapter-ack:check");
    expect(directText).toContain(
      "validation=<code>pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check</code>",
    );
    expect(directText).toContain(
      "postApply=<code>pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check</code>",
    );
    expect(directText).toContain("capitalAdapterAckApplyReceipt=pending_operator_apply");
    expect(directText).toContain("operator-apply:pending");
    expect(directText).toContain("策略/實單完成矩陣");
    expect(directText).toContain("pass=4/8");
    expect(directText).toContain("writeBrokerOrders=❌");
    expect(directText).toContain("operator-packet:execution-ready");
    expect(directText).toContain("策略 Tail-Risk 修復");
    expect(directText).toContain("candidatePlan=<code>needs_candidate_or_outcome_evidence</code>");
    expect(directText).toContain("rerunEvidence=<code>ready_for_same_case_rerun</code>");
    expect(directText).toContain("ranked=<code>1:YM0000:-40|2:NQ0000:-80|3:MCL0000:-400</code>");
    expect(directText).toContain(
      "followUp=<code>pnpm capital:strategy:fill-simulation:check</code>",
    );
    expect(directText).toContain("noOrderWrite=✅");
    expect(directText).toContain("fresh_resolved_low_correlation_or_opposite_exposure");
    expect(directText).toContain("contract_point_value_currency_backfill");
    expect(directText).toContain("quote_fresh_matched:session_closed");
    expect(getButtonValues(directPanel)).toContain("sc:tr:direct");
    expect(getButtonValues(directPanel)).toContain("sc:tr:directrun");
    expect(getButtonValues(directPanel)).toContain("sc:tr:localexec");
    expect(getButtonValues(directPanel)).toContain("sc:tr:armprofile");
    expect(getButtonValues(directPanel)).toContain("sc:tr:directpos");
    expect(getButtonValues(directPanel)).toContain("sc:tr:ackapply");
    expect(getButtonValues(directPanel)).toContain("sc:tr:receipt");
    expect(getButtonValues(directPanel)).toContain("sc:tr:cap");
    expect(getButtonValues(directPanel)).toContain("sc:trade");
  });

  it("renders Capital live executor arm profile as read-only drill-down", () => {
    const panel = buildCapitalLiveExecutorArmProfilePanel(buildLiveExecutorArmProfileFixture());
    const text = getTextBlocksText(panel);

    expect(text).toContain("Live Executor Arm Profile");
    expect(text).toContain("status=<code>expired</code>");
    expect(text).toContain("armed=✅");
    expect(text).toContain("allowExecutorWrite=❌");
    expect(text).toContain("expired=✅");
    expect(text).toContain("directConversationWrite=❌");
    expect(text).toContain("capital-live-executor-arm-profile.json");
    expect(text).toContain("capital-live-executor-arm-profile.template.json");
    expect(text).toContain("capital-live-executor-arm-profile.staged-rearm.json");
    expect(text).toContain("Operator Rearm Handoff");
    expect(text).toContain("staged_rearm_candidate_ready_for_operator");
    expect(text).toContain("operator-managed-local-broker-executor-only");
    expect(text).toContain("activeProfileWriteSuppressed=✅");
    expect(text).toContain("conversationMayWriteActiveProfile=❌");
    expect(text).toContain("candidateArmed=❌");
    expect(text).toContain(
      "validation=<code>pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check</code>",
    );
    expect(text).toContain(
      "postRearm=<code>pnpm --dir D:\\OpenClaw capital:live-readiness:check</code>",
    );
    expect(text).toContain("review_staged_rearm_profile");
    expect(text).toContain("operator_managed_active_profile_rearm");
    expect(text).toContain("rerun_live_readiness");
    expect(text).toContain("必要條件 observed flags");
    expect(text).toContain("killSwitch: required=✅ observed=✅");
    expect(text).toContain("adapterAckHashRequired: required=✅ observed=✅");
    expect(text).toContain("noLiveOrderSent=✅");
    expect(text).toContain("sentOrder=❌");
    expect(text).toContain("brokerWriteAttempted=❌");
    expect(text).toContain("conversationAgentDirectBrokerWrite=❌");
    expect(text).toContain("capitalLiveExecutorArmProfile=expired");
    expect(text).toContain("pnpm capital:trade:live-executor-profile:check");
    expect(getButtonValues(panel)).toContain("sc:tr:armprofile");
    expect(getButtonValues(panel)).toContain("sc:tr:direct");
    expect(getButtonValues(panel)).toContain("sc:tr:localexec");
  });

  it("renders Capital local executor dispatch as read-only drill-down", () => {
    const panel = buildCapitalLocalExecutorDispatchPanel(buildLocalExecutorDispatchFixture());
    const text = getTextBlocksText(panel);

    expect(text).toContain("本地執行器 Dispatch");
    expect(text).toContain("status=<code>已阻擋</code>");
    expect(text).toContain("dispatch=<code>blocked_do_not_send</code>");
    expect(text).toContain("operatorCanExecute=❌");
    expect(text).toContain("executorArmed=❌");
    expect(text).toContain("sealedOrderIntent.sha256=<code>ABC123</code>");
    expect(text).toContain("payloadHash=<code>PAYLOAD123</code>");
    expect(text).toContain("noOrderWrite=✅");
    expect(text).toContain("sentOrder=❌");
    expect(text).toContain("brokerApiCalled=❌");
    expect(text).toContain("wroteBrokerCommand=❌");
    expect(text).toContain("capitalLocalExecutorDispatch=blocked");
    expect(text).toContain("operatorPacket:not-executable");
    expect(getButtonValues(panel)).toContain("sc:tr:localexec");
    expect(getButtonValues(panel)).toContain("sc:tr:direct");
    expect(getButtonValues(panel)).toContain("sc:tr:directrun");
  });

  it("renders OKX order proposal gate as dry-run only", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const proposalPanel = buildOkxOrderProposalPanel({
      generatedAt: "2026-05-24T02:12:37.935Z",
      mode: "dry_run_proposal_only",
      code: "dry_run_proposal_blocked",
      status: "blocked",
      summary_zh_tw: "OKX <proposal>& blocked",
      blockers: ["chat_supplied_secret_must_rotate<danger>&"],
      markers: ["dry_run_proposal_blocked", "submitted_order_false"],
      requestedOrder: {
        profile: "demo",
        market: "spot",
        instId: "BTC-USDT",
        side: "buy",
        ordType: "market",
        tdMode: "cash",
        size: "0",
        isActionableOrder: false,
      },
      quoteContext: { instId: "BTC-USDT", last: "76899.1", bidPx: "76899", askPx: "76899.1" },
      preTradeChecks: {
        apiStatusSchemaOk: true,
        quoteOk: true,
        demoAuthOk: true,
        chatPostedKeyRotated: false,
        ipAllowlistSafe: false,
      },
      safety: {
        dryRunOnly: true,
        executionAllowed: false,
        submittedOrder: false,
        orderPlacementEnabled: false,
        liveTradingEnabled: false,
        writeTradingEnabled: false,
      },
      nextSafeTask: "重建 read-only key",
    });

    const tradingValues = getButtonValues(tradingPanel);
    const proposalText = getTextBlocksText(proposalPanel);

    expect(tradingValues).toContain("sc:tr:okxord");
    expect(proposalText).toContain("OKX 下單提案");
    expect(proposalText).toContain("模擬提案已阻擋");
    expect(proposalText).toContain("僅模擬: ✅");
    expect(proposalText).toContain("已送單: ❌");
    expect(proposalText).toContain("OKX &lt;proposal&gt;&amp; blocked");
    expect(proposalText).toContain("chat_supplied_secret_must_rotate&lt;danger&gt;&amp;");
    expect(getButtonValues(proposalPanel)).toContain("sc:tr:okxord");
    expect(getButtonValues(proposalPanel)).toContain("sc:tr:okx");
    expect(getButtonValues(proposalPanel)).toContain("sc:trade");
  });

  it("renders OKX order status gate without private order writes", () => {
    const tradingPanel = buildTradingPanel({
      mode: "paper",
      connected: true,
      quoteStatus: "fresh",
      positions: [],
      quotes: [],
      blockers: [],
    });
    const statusPanel = buildOkxOrderStatusPanel({
      generatedAt: "2026-05-24T04:21:41.273Z",
      mode: "read_only_order_lifecycle_status",
      code: "no_submitted_order_to_track",
      status: "blocked",
      summary_zh_tw: "OKX <status>& cancel disabled",
      blockers: ["chat_supplied_secret_must_rotate<danger>&"],
      markers: ["order_status_read_only", "cancel_not_enabled"],
      trackedOrder: {
        profile: "demo",
        market: "spot",
        instId: "BTC-USDT",
        ordId: "",
        clOrdId: "",
        submittedOrder: false,
        orderStatus: "none",
        queryEnabled: false,
      },
      cancelStatus: {
        cancelOrderEnabled: false,
        cancelSubmitted: false,
        cancelStatus: "not_applicable",
      },
      paperAuditSummary: {
        status: "ready_read_only",
        code: "paper_audit_summary_ready",
        counts: {
          totalEntries: 1,
        },
        latestEntry: {
          status: "ready_no_exchange_write",
          code: "demo_order_simulation_result_ready",
        },
        safetyAggregate: {
          allEntriesSafe: true,
          submittedOrder: 0,
          exchangeWriteAttempted: 0,
          orderStatusQueryExecuted: 0,
          cancelSubmitted: 0,
        },
        blockers: [],
      },
      safety: {
        readOnly: true,
        dryRunOnly: true,
        executionAllowed: false,
        orderPlacementEnabled: false,
        cancelOrderEnabled: false,
        submittedOrder: false,
        orderStatusQueryExecuted: false,
        writeTradingEnabled: false,
      },
      officialEndpointMap: {
        orderDetails: { method: "GET", path: "/api/v5/trade/order", permission: "Read" },
        pendingOrders: { method: "GET", path: "/api/v5/trade/orders-pending", permission: "Read" },
        cancelOrder: { method: "POST", path: "/api/v5/trade/cancel-order", permission: "Trade" },
      },
      nextSafeTask: "重建 read-only key",
    });

    const tradingValues = getButtonValues(tradingPanel);
    const statusText = getTextBlocksText(statusPanel);

    expect(tradingValues).toContain("sc:tr:okxstat");
    expect(statusText).toContain("OKX 訂單/撤單狀態");
    expect(statusText).toContain("無可追蹤已送單");
    expect(statusText).toContain("已送單=❌");
    expect(statusText).toContain("狀態=<code>無</code>");
    expect(statusText).toContain("狀態=<code>不適用</code>");
    expect(statusText).not.toContain("status=<code>none</code>");
    expect(statusText).not.toContain("status=<code>not_applicable</code>");
    expect(statusText).toContain("撤單");
    expect(statusText).toContain("啟用=❌");
    expect(statusText).toContain("GET /api/v5/trade/order");
    expect(statusText).toContain("POST /api/v5/trade/cancel-order");
    expect(statusText).toContain("(讀取)");
    expect(statusText).toContain("(交易)");
    expect(statusText).not.toContain("(Read)");
    expect(statusText).not.toContain("(Trade)");
    expect(statusText).toContain("模擬稽核");
    expect(statusText).toContain("模擬稽核摘要就緒");
    expect(statusText).toContain("全部安全=✅");
    expect(statusText).toContain("已送單=0");
    expect(statusText).toContain("訂單狀態查詢次數=0");
    expect(statusText).toContain("openclaw-okx-paper-audit-summary-latest.json");
    expect(statusText).toContain("OKX &lt;status&gt;&amp; cancel disabled");
    expect(statusText).toContain("chat_supplied_secret_must_rotate&lt;danger&gt;&amp;");
    expect(getButtonValues(statusPanel)).toContain("sc:tr:okxstat");
    expect(getButtonValues(statusPanel)).toContain("sc:tr:okxord");
    expect(getButtonValues(statusPanel)).toContain("sc:tr:okx");
    expect(getButtonValues(statusPanel)).toContain("sc:trade");
  });
});
