#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function readPackageJson(repoRoot) {
  const filePath = path.join(repoRoot, "package.json");
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function assertFileExists(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch (error) {
    throw new Error(`${label} missing: ${filePath}`, { cause: error });
  }
}

async function assertTextContains(filePath, expectedToken, label) {
  const content = await fs.readFile(filePath, "utf8");
  if (!content.includes(expectedToken)) {
    throw new Error(`${label} must include ${expectedToken}`);
  }
}

function assertScriptContains(scripts, key, expectedToken) {
  const value = scripts?.[key];
  if (typeof value !== "string" || !value.includes(expectedToken)) {
    throw new Error(`package.json script ${key} must include ${expectedToken}`);
  }
}

function assertJsonField(value, predicate, label) {
  if (!predicate(value)) {
    throw new Error(`${label} contract failed`);
  }
}

function countTokenOccurrences(value, token) {
  if (typeof value !== "string" || token.length === 0) {
    return 0;
  }
  return value.split(token).length - 1;
}

function assertTokenCount(value, token, expected, label) {
  const actual = countTokenOccurrences(value, token);
  if (actual !== expected) {
    throw new Error(`${label} expected ${token} count=${expected}, got ${actual}`);
  }
}

function buildNoDuplicateTradingShortcutsFixture() {
  return {
    summary: {
      shortcutCheckCountClosure: {
        machineLine:
          "shortcutChecks=218 failed=0 assistantClosure=40 okxClosure=18 fixtureCoverage=4 reportMachine=10 growthReason=assistant+okx+fixture+report-machine",
      },
      capitalOperatorPacketClosure: {
        status: "visible_blocked",
        reportRead: true,
        operatorCanExecute: false,
        noOrderWrite: true,
        sentOrder: false,
        readinessStatus: "blocked",
        adapterAckStatus: "blocked",
        dispatchPolicy: "blocked_do_not_send",
        blockerCount: 17,
        machineLine:
          "capitalOperatorPacket=blocked sha256=E515 readiness=blocked adapterAck=blocked operatorCanExecute=false noOrderWrite=true sentOrder=false blockers=17",
      },
      capitalLocalExecutorDispatchClosure: {
        status: "visible_blocked",
        reportRead: true,
        dispatchStatus: "blocked",
        dispatchPolicy: "blocked_do_not_send",
        operatorCanExecute: false,
        executorArmed: false,
        noOrderWrite: true,
        sentOrder: false,
        sealedOrderIntentSha256: "E515",
        blockerCount: 23,
        machineLine:
          "capitalLocalExecutorDispatch=blocked sha256=E515 operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send payloadHash=H515 noOrderWrite=true sentOrder=false blockers=23",
      },
      capitalVerifiedPositionSnapshotClosure: {
        status: "stale_operator_refresh_required",
        reportRead: true,
        usable: true,
        decisionStatus: "verified_flat_no_exit_required",
        freshnessStatus: "stale",
        verifiedAgeSeconds: 45285,
        maxFreshSeconds: 43200,
        hasOpenPosition: false,
        netContracts: 0,
        nextCommand: "pnpm capital:trade:direct:status:check",
        noOrderWrite: true,
        sentOrder: false,
        machineLine:
          "capitalVerifiedPositionSnapshot=stale_operator_refresh_required;decision=verified_flat_no_exit_required;freshness=stale;age=45285;maxFresh=43200;hasOpenPosition=false;net=0;path=D:\\OpenClaw\\config\\capital-verified-position-snapshot.json;next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check;noOrderWrite=true",
      },
      okxCurrentReadinessRefreshWorkflowClosure: {
        machineLine: "okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok noOrderWrite=true",
        noOrderWrite: true,
      },
      okxCurrentReadinessHeartbeatOperationClosure: {
        telegramCallback: "sc:tr:okxrefresh",
        refreshCommand: "pnpm okx:current-readiness:refresh",
        executeRequired: false,
        noOrderWrite: true,
        schedulerNextRunAt: "2026-05-24T20:15:00.000Z",
        machineLine:
          "okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true",
      },
      okxSchedulerNoOrderContractProbeClosure: {
        status: "ready",
        noOrderWrite: true,
        machineLine:
          "okxSchedulerNoOrderContract=pass reports=3/3 schedulerNextRunAt=2026-05-24T20:15:00.000Z current=pass refresh=pass heartbeat=pass noOrderWrite=true",
      },
      assistantClosure: {
        assistantLearningHint: {
          nextCommandShortRow: {
            machineLine:
              "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
          },
        },
      },
    },
  };
}

function assertNoDuplicateShortcutSuffix(message, label) {
  assertTokenCount(message, "快捷檢查=shortcutChecks=", 1, label);
  assertTokenCount(message, "TradingAgents=tradingAgents=", 1, label);
  assertTokenCount(message, "真單Packet=capitalOperatorPacket=", 1, label);
  assertTokenCount(message, "本地執行器=capitalLocalExecutorDispatch=", 1, label);
  assertTokenCount(message, "倉位快照=capitalVerifiedPositionSnapshot=", 1, label);
  assertTokenCount(message, "OKX刷新=okxCurrentReadinessRefresh=", 1, label);
  assertTokenCount(message, "OKX心跳=okxHeartbeatRefresh=", 1, label);
  assertTokenCount(message, "OKX合約=okxSchedulerNoOrderContract=", 1, label);
  if (message.includes("receiptPrompt=")) {
    assertTokenCount(message, "回關收據命令=receiptPrompt=", 1, label);
  }
  if (!message.includes("schedulerNextRunAt=")) {
    throw new Error(`${label} missing schedulerNextRunAt=`);
  }
  assertTokenCount(message, "下一步指令=nextCommandShortRow=", 1, label);
}

function assertGeneratedReportTokenCounts(report) {
  assertJsonField(
    report.messageTokenCounts?.tradingAgents,
    (value) => value === 1,
    "messageTokenCounts.tradingAgents",
  );
  assertJsonField(
    report.messageTokenCounts?.shortcutChecks,
    (value) => value === 1,
    "messageTokenCounts.shortcutChecks",
  );
  assertJsonField(
    report.messageTokenCounts?.receiptPrompt,
    (value) => value === 1,
    "messageTokenCounts.receiptPrompt",
  );
  assertJsonField(
    report.messageTokenCounts?.localExecutorDispatch,
    (value) => value === 1,
    "messageTokenCounts.localExecutorDispatch",
  );
  assertJsonField(
    report.messageTokenCounts?.positionSnapshot,
    (value) => value === 1,
    "messageTokenCounts.positionSnapshot",
  );
  assertJsonField(
    report.messageTokenCounts?.okxRefresh,
    (value) => value === 1,
    "messageTokenCounts.okxRefresh",
  );
  assertJsonField(
    report.messageTokenCounts?.okxHeartbeat,
    (value) => value === 1,
    "messageTokenCounts.okxHeartbeat",
  );
  assertJsonField(
    report.messageTokenCounts?.okxContract,
    (value) => value === 1,
    "messageTokenCounts.okxContract",
  );
  assertJsonField(
    report.messageTokenCounts?.executeRequired,
    (value) => value === 1,
    "messageTokenCounts.executeRequired",
  );
  assertJsonField(
    report.messageTokenCounts?.noOrderWrite,
    (value) => value === 4,
    "messageTokenCounts.noOrderWrite",
  );
  assertJsonField(
    report.messageTokenCounts?.nextCommand,
    (value) => value === 1,
    "messageTokenCounts.nextCommand",
  );
  assertJsonField(
    report.messageTokenCountsSummaryZhTw,
    (value) =>
      typeof value === "string" &&
      value.includes("TradingAgents=1") &&
      value.includes("回關收據命令=1") &&
      value.includes("本地執行器=1") &&
      value.includes("倉位快照=1") &&
      value.includes("OKX刷新=1") &&
      value.includes("OKX心跳=1") &&
      value.includes("OKX合約=1") &&
      value.includes("executeRequired=1") &&
      value.includes("noOrderWrite=true=4"),
    "messageTokenCountsSummaryZhTw",
  );
}

function assertGeneratedBridgeUpstreamTokenCounts(report) {
  assertJsonField(
    report.upstreamMessageTokenCounts?.executeRequired,
    (value) => value === 1,
    "upstreamMessageTokenCounts.executeRequired",
  );
  assertJsonField(
    report.upstreamMessageTokenCounts?.noOrderWrite,
    (value) => value === 4,
    "upstreamMessageTokenCounts.noOrderWrite",
  );
  assertJsonField(
    report.upstreamMessageTokenCounts?.localExecutorDispatch,
    (value) => value === 1,
    "upstreamMessageTokenCounts.localExecutorDispatch",
  );
  assertJsonField(
    report.upstreamMessageTokenCounts?.positionSnapshot,
    (value) => value === 1,
    "upstreamMessageTokenCounts.positionSnapshot",
  );
  assertJsonField(
    report.upstreamMessageTokenCounts?.receiptPrompt,
    (value) => value === 1,
    "upstreamMessageTokenCounts.receiptPrompt",
  );
  assertJsonField(
    report.upstreamMessageTokenCounts?.okxContract,
    (value) => value === 1,
    "upstreamMessageTokenCounts.okxContract",
  );
  assertJsonField(
    report.upstreamMessageTokenCountsSummaryZhTw,
    (value) =>
      typeof value === "string" &&
      value.includes("executeRequired=1") &&
      value.includes("回關收據命令=1") &&
      value.includes("本地執行器=1") &&
      value.includes("倉位快照=1") &&
      value.includes("OKX合約=1") &&
      value.includes("noOrderWrite=true=4"),
    "upstreamMessageTokenCountsSummaryZhTw",
  );
  assertJsonField(
    report.upstreamNoOrderWriteCount,
    (value) => value === 4,
    "upstreamNoOrderWriteCount",
  );
  assertJsonField(
    report.upstreamNoOrderWriteVerified,
    (value) => value === true,
    "upstreamNoOrderWriteVerified",
  );
  assertJsonField(
    report.upstreamOkxContractCount,
    (value) => value === 1,
    "upstreamOkxContractCount",
  );
  assertJsonField(
    report.upstreamOkxContractVerified,
    (value) => value === true,
    "upstreamOkxContractVerified",
  );
  assertJsonField(
    report.upstreamSchedulerNextRunAt,
    (value) => typeof value === "string" && value.length > 0,
    "upstreamSchedulerNextRunAt",
  );
}

async function assertNoDuplicateSuffixRegression(publishPath) {
  const { buildMessage } = await import(pathToFileURL(publishPath).href);
  if (typeof buildMessage !== "function") {
    throw new Error("telegram publish bridge must export buildMessage for suffix regression");
  }
  const fixture = buildNoDuplicateTradingShortcutsFixture();
  const tradingAgentsFixture = {
    status: "simulated_ready",
    runtime: {
      provider: "simulated",
      mode: "paper_signal_only",
      noOrderWrite: true,
      brokerWriteAttempted: false,
    },
    canAnalyzeNow: true,
    canUseOfficialTradingAgents: false,
    no_live_order_sent: true,
    brokerWriteAttempted: false,
    nextSafeTask: "run pnpm tradingagents:install only after explicit human approval",
  };
  const completeMessage = [
    "[OpenClaw] 成功",
    "快捷檢查=shortcutChecks=218 failed=0",
    "TradingAgents=tradingAgents=simulated_ready provider=simulated mode=paper_signal_only canAnalyze=true official=false noOrderWriteVerified=true noLiveOrderSent=true brokerWriteAttempted=false next=run pnpm tradingagents:install only after explicit human approval",
    "自動回關=autoDeactivate=ready_to_deactivate execute=false applied=false enabledAfter=true activationExpired=true sentOrder=false operatorActionRequired=true operatorAction=pnpm capital:live-trading:operator:auto-deactivate:execute operatorReason=expired_live_write_still_enabled blockers=none",
    "回關收據命令=receiptPrompt=pending_explicit_execute_receipt action=verify_receipt_gate command=pnpm_capital:live-trading:operator:auto-deactivate:receipt:check receiptVerified=false heartbeatExecuteAllowed=false noLiveOrderSent=true sentOrder=false",
    "真單Packet=capitalOperatorPacket=blocked operatorCanExecute=false readiness=blocked adapterAck=blocked dispatchPolicy=blocked_do_not_send sentOrder=false blockers=17",
    "本地執行器=capitalLocalExecutorDispatch=blocked operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send sentOrder=false blockers=23 noOrderWrite=true",
    "倉位快照=capitalVerifiedPositionSnapshot=stale_operator_refresh_required decision=verified_flat_no_exit_required freshness=stale next=sc:tr:directpos command=pnpm capital:trade:direct:status:check noOrderWrite=true",
    "OKX刷新=okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok noOrderWrite=true",
    "OKX心跳=okxHeartbeatRefresh=sc:tr:okxrefresh command=pnpm okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z executeRequired=false noOrderWrite=true",
    "OKX合約=okxSchedulerNoOrderContract=pass reports=3/3 schedulerNextRunAt=2026-05-24T20:15:00.000Z current=pass refresh=pass heartbeat=pass noOrderWriteVerified=true",
    "下一步指令=nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true",
  ].join("｜");
  const unchangedMessage = buildMessage(
    { telegram_summary_oneline_zh_tw: completeMessage },
    { tradingShortcutsReport: fixture, tradingAgentsReport: tradingAgentsFixture },
  );
  if (unchangedMessage !== completeMessage) {
    throw new Error("complete publish message must not receive duplicate suffix fields");
  }
  assertNoDuplicateShortcutSuffix(unchangedMessage, "complete message");

  const completeMessageWithTokenCounts = [
    completeMessage,
    "OKX心跳計數=messageTokenCounts 快捷檢查=1 TradingAgents=1 回關收據命令=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1",
  ].join("｜");
  const unchangedMessageWithTokenCounts = buildMessage(
    { telegram_summary_oneline_zh_tw: completeMessageWithTokenCounts },
    { tradingShortcutsReport: fixture, tradingAgentsReport: tradingAgentsFixture },
  );
  if (unchangedMessageWithTokenCounts !== completeMessageWithTokenCounts) {
    throw new Error(
      "complete publish message with token counts must not receive duplicate suffix fields",
    );
  }
  assertNoDuplicateShortcutSuffix(
    unchangedMessageWithTokenCounts,
    "complete message with token counts",
  );

  const heartbeatMissingMessage = [
    "[OpenClaw] 成功",
    "快捷檢查=shortcutChecks=218 failed=0",
    "OKX刷新=okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok noOrderWrite=true",
    "下一步指令=nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true",
  ].join("｜");
  const heartbeatOnlyAppendedMessage = buildMessage(
    { telegram_summary_oneline_zh_tw: heartbeatMissingMessage },
    { tradingShortcutsReport: fixture, tradingAgentsReport: tradingAgentsFixture },
  );
  assertNoDuplicateShortcutSuffix(heartbeatOnlyAppendedMessage, "heartbeat-only append message");

  const receiptPromptAppendedMessage = buildMessage(
    {
      telegram_summary_oneline_zh_tw: heartbeatMissingMessage,
      live_auto_deactivate_receipt_prompt: {
        machineLine:
          "receiptPrompt=pending_explicit_execute_receipt action=verify_receipt_gate command=pnpm_capital:live-trading:operator:auto-deactivate:receipt:check receiptVerified=false heartbeatExecuteAllowed=false noLiveOrderSent=true sentOrder=false",
      },
    },
    { tradingShortcutsReport: fixture, tradingAgentsReport: tradingAgentsFixture },
  );
  assertTokenCount(
    receiptPromptAppendedMessage,
    "回關收據命令=receiptPrompt=",
    1,
    "receipt prompt append message",
  );
  assertNoDuplicateShortcutSuffix(receiptPromptAppendedMessage, "receipt prompt append message");
}

async function main() {
  const repoRoot = process.cwd();
  const publishPath = path.join(
    repoRoot,
    "scripts",
    "openclaw-controlled-task-runner-telegram-publish.mjs",
  );
  const inventoryPath = path.join(repoRoot, "scripts", "openclaw-autonomous-inventory.mjs");
  const runnerPath = path.join(repoRoot, "scripts", "openclaw-controlled-task-runner.mjs");
  const latestPublishReportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-controlled-task-runner-telegram-publish-latest.json",
  );
  const latestBridgeReportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-controlled-task-runner-telegram-publish-bridge-latest.json",
  );
  await assertFileExists(publishPath, "telegram publish bridge");
  await assertFileExists(inventoryPath, "autonomous inventory gate");
  await assertFileExists(runnerPath, "controlled task runner");
  await assertFileExists(latestPublishReportPath, "telegram publish dry-run report");
  await assertFileExists(latestBridgeReportPath, "telegram publish bridge status report");
  await assertTextContains(publishPath, "errorCode", "telegram publish bridge");
  await assertTextContains(publishPath, "summaryPath", "telegram publish bridge");
  await assertTextContains(publishPath, "reportPath", "telegram publish bridge");
  await assertTextContains(
    publishPath,
    "openclaw-telegram-trading-shortcuts-latest.json",
    "telegram publish bridge",
  );
  await assertTextContains(
    publishPath,
    "openclaw-tradingagents-summary-latest.json",
    "telegram publish bridge",
  );
  await assertTextContains(publishPath, "shortcutChecks=", "telegram publish bridge");
  await assertTextContains(publishPath, "TradingAgents=", "telegram publish bridge");
  await assertTextContains(publishPath, "tradingAgents=", "telegram publish bridge");
  await assertTextContains(publishPath, "receiptPrompt=", "telegram publish bridge");
  await assertTextContains(publishPath, "回關收據命令=", "telegram publish bridge");
  await assertTextContains(publishPath, "capitalOperatorPacket", "telegram publish bridge");
  await assertTextContains(publishPath, "真單Packet=", "telegram publish bridge");
  await assertTextContains(publishPath, "capitalLocalExecutorDispatch", "telegram publish bridge");
  await assertTextContains(publishPath, "本地執行器=", "telegram publish bridge");
  await assertTextContains(
    publishPath,
    "capitalVerifiedPositionSnapshot",
    "telegram publish bridge",
  );
  await assertTextContains(publishPath, "倉位快照=", "telegram publish bridge");
  await assertTextContains(publishPath, "nextCommandShortRow=", "telegram publish bridge");
  await assertTextContains(publishPath, "OKX刷新=", "telegram publish bridge");
  await assertTextContains(publishPath, "OKX心跳=", "telegram publish bridge");
  await assertTextContains(publishPath, "okxCurrentReadinessRefresh=", "telegram publish bridge");
  await assertTextContains(publishPath, "okxHeartbeatRefresh=", "telegram publish bridge");
  await assertTextContains(publishPath, "schedulerNextRunAt=", "telegram publish bridge");
  await assertTextContains(publishPath, "executeRequired=", "telegram publish bridge");
  await assertTextContains(publishPath, "noOrderWrite=true", "telegram publish bridge");
  await assertTextContains(publishPath, "messageTokenCounts", "telegram publish bridge");
  await assertTextContains(publishPath, "messageTokenCountsSummaryZhTw", "telegram publish bridge");
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-summary-okx-refresh",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-message-tradingagents",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-summary-tradingagents",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-count-tradingagents",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-summary-okx-heartbeat",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-summary-no-order-write",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-count-no-order-write",
    "autonomous inventory gate",
  );
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-telegram-publish-token-count-receipt-prompt",
    "autonomous inventory gate",
  );
  await assertTextContains(publishPath, "export function buildMessage", "telegram publish bridge");
  await assertTextContains(
    runnerPath,
    "openclaw-telegram-trading-shortcuts-latest.json",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "openclaw-tradingagents-summary-latest.json",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "trading_agents", "controlled task runner");
  await assertTextContains(runnerPath, "TradingAgents=", "controlled task runner");
  await assertTextContains(runnerPath, "telegram_trading_shortcuts", "controlled task runner");
  await assertTextContains(runnerPath, "capital_operator_packet", "controlled task runner");
  await assertTextContains(runnerPath, "capital_local_executor_dispatch", "controlled task runner");
  await assertTextContains(runnerPath, "capitalOperatorPacket", "controlled task runner");
  await assertTextContains(runnerPath, "capitalLocalExecutorDispatch", "controlled task runner");
  await assertTextContains(runnerPath, "快捷檢查=", "controlled task runner");
  await assertTextContains(runnerPath, "nextCommandShortRow", "controlled task runner");
  await assertTextContains(runnerPath, "trading_next_command", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "upstreamMessageTokenCountsSummaryZhTw",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "tradingReadiness=quote:", "controlled task runner");
  await assertTextContains(runnerPath, "交易就緒=報價:", "controlled task runner");
  await assertTextContains(
    inventoryPath,
    "contract-probe:controlled-runner-trading-readiness-machine-line",
    "autonomous inventory gate",
  );
  await assertTextContains(runnerPath, "upstreamNoOrderWriteVerified", "controlled task runner");
  await assertTextContains(runnerPath, "upstreamOkxContractVerified", "controlled task runner");
  await assertTextContains(runnerPath, "upstreamSchedulerNextRunAt", "controlled task runner");

  const latestPublishReport = await readJson(latestPublishReportPath);
  assertJsonField(latestPublishReport.status, (value) => value === "dry_run_ok", "status");
  assertJsonField(latestPublishReport.errorCode, (value) => value === "OK", "errorCode");
  assertJsonField(latestPublishReport.dryRun, (value) => value === true, "dryRun");
  assertJsonField(latestPublishReport.dryRunNoSend, (value) => value === true, "dryRunNoSend");
  assertJsonField(
    latestPublishReport.commandErrorCode,
    (value) => value === "DRY_RUN_NO_SEND",
    "commandErrorCode",
  );
  assertJsonField(
    latestPublishReport.message,
    (value) =>
      typeof value === "string" &&
      value.includes("快捷檢查=shortcutChecks=") &&
      value.includes("TradingAgents=tradingAgents=") &&
      value.includes("noOrderWriteVerified=true") &&
      value.includes("noLiveOrderSent=true") &&
      value.includes("brokerWriteAttempted=false") &&
      value.includes("回關收據命令=receiptPrompt=") &&
      value.includes("真單Packet=capitalOperatorPacket=") &&
      value.includes("本地執行器=capitalLocalExecutorDispatch=") &&
      value.includes("executorArmed=false") &&
      value.includes("operatorCanExecute=false") &&
      value.includes("倉位快照=capitalVerifiedPositionSnapshot=") &&
      value.includes("next=sc:tr:directpos") &&
      value.includes("下一步指令=nextCommandShortRow=") &&
      value.includes("OKX刷新=okxCurrentReadinessRefresh=") &&
      value.includes("OKX心跳=okxHeartbeatRefresh=") &&
      value.includes("交易就緒=報價:") &&
      value.includes("模擬:") &&
      value.includes("下單模式:") &&
      value.includes("schedulerNextRunAt=") &&
      value.includes("executeRequired=") &&
      value.includes("noOrderWrite=true"),
    "message",
  );
  assertNoDuplicateShortcutSuffix(latestPublishReport.message, "latest publish report message");
  assertGeneratedReportTokenCounts(latestPublishReport);
  const latestBridgeReport = await readJson(latestBridgeReportPath);
  assertJsonField(latestBridgeReport.status, (value) => value === "dry_run_ok", "bridge status");
  assertGeneratedBridgeUpstreamTokenCounts(latestBridgeReport);
  await assertNoDuplicateSuffixRegression(publishPath);

  const packageJson = await readPackageJson(repoRoot);
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:telegram:publish",
    "scripts/openclaw-controlled-task-runner-telegram-publish.mjs --dry-run",
  );
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:telegram:publish:execute",
    "scripts/openclaw-controlled-task-runner-telegram-publish.mjs --execute",
  );
  assertScriptContains(
    packageJson.scripts,
    "check:openclaw-controlled-task-runner-telegram-publish",
    "scripts/check-openclaw-controlled-task-runner-telegram-publish.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:live-trading:approval:telegram:check",
    "scripts/check-capital-live-trading-approval-telegram-publish.mjs",
  );

  process.stdout.write("OPENCLAW_CONTROLLED_TASK_RUNNER_TELEGRAM_PUBLISH_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw controlled task runner telegram publish check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
