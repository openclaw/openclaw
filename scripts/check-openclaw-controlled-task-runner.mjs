#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

async function readPackageJson(repoRoot) {
  const filePath = path.join(repoRoot, "package.json");
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

async function main() {
  const repoRoot = process.cwd();
  const runnerPath = path.join(repoRoot, "scripts", "openclaw-controlled-task-runner.mjs");
  const watchPath = path.join(repoRoot, "scripts", "openclaw-controlled-task-runner-watch.mjs");
  const publishPath = path.join(
    repoRoot,
    "scripts",
    "openclaw-controlled-task-runner-telegram-publish.mjs",
  );
  const inventoryPath = path.join(repoRoot, "scripts", "openclaw-autonomous-inventory.mjs");
  const equitySizerCheckPath = path.join(
    repoRoot,
    "scripts",
    "check-capital-strategy-equity-position-sizer.mjs",
  );

  await assertFileExists(runnerPath, "controlled task runner");
  await assertFileExists(watchPath, "controlled task runner watch");
  await assertFileExists(publishPath, "controlled task runner telegram publish");
  await assertFileExists(inventoryPath, "autonomous inventory");
  await assertFileExists(equitySizerCheckPath, "capital strategy equity position sizer check");
  await assertTextContains(
    watchPath,
    "openclaw-controlled-task-runner-watch-latest.json",
    "controlled task runner watch",
  );
  await assertTextContains(
    watchPath,
    "openclaw-controlled-task-runner-watch-runs.jsonl",
    "controlled task runner watch",
  );
  await assertTextContains(
    runnerPath,
    "openclaw-controlled-task-runner-telegram-latest.json",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "openclaw-controlled-task-runner-telegram-latest.md",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "openclaw-controlled-task-runner-telegram-publish.mjs",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "autonomous:test:changed:closure", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "test_changed_closure_contract_check",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "check:openclaw-test-changed-closure",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "errorCode", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "CAPITAL_QUICK_QUOTE_LATEST_PATH_ENV",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "capital_quick_quote_latest", "controlled task runner");
  await assertTextContains(runnerPath, "quick_quote_status", "controlled task runner");
  await assertTextContains(runnerPath, "covered_by_fresh_quote_gate", "controlled task runner");
  await assertTextContains(runnerPath, "covered_by_service_status", "controlled task runner");
  await assertTextContains(runnerPath, "coveredByServiceStatus", "controlled task runner");
  await assertTextContains(runnerPath, "coveredByFreshQuoteGate", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "isCapitalQuoteStatusAuthoritativeReady",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "`- quick_quote: ${summary.quick_quote_status}`",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "capital_paper_assistant_state", "controlled task runner");
  await assertTextContains(runnerPath, "liveOrder=", "controlled task runner");
  await assertTextContains(runnerPath, "真單=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_live_trading_approval_summary",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital_live_trading_approval_telegram_publish",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "liveApprovalTelegram=", "controlled task runner");
  await assertTextContains(runnerPath, "真單回報=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_live_trading_operator_auto_deactivate",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital_live_trading_operator_auto_deactivate_receipt_check",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital:live-trading:operator:auto-deactivate:receipt:check",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "isCapitalLiveTradingOperatorAutoDeactivateReceiptPending",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "autoDeactivateReceiptPending", "controlled task runner");
  await assertTextContains(runnerPath, "liveAutoDeactivate=", "controlled task runner");
  await assertTextContains(runnerPath, "自動回關=", "controlled task runner");
  await assertTextContains(runnerPath, "operatorActionRequired=", "controlled task runner");
  await assertTextContains(runnerPath, "operatorAction=", "controlled task runner");
  await assertTextContains(runnerPath, "operatorAudit=", "controlled task runner");
  await assertTextContains(runnerPath, "operatorExplicitExecute=", "controlled task runner");
  await assertTextContains(runnerPath, "heartbeatExecuteAllowed=", "controlled task runner");
  await assertTextContains(runnerPath, "operatorReceipt=", "controlled task runner");
  await assertTextContains(runnerPath, "receiptRiskChanged=", "controlled task runner");
  await assertTextContains(runnerPath, "receiptRollback=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_RECEIPT_GATE_REL",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "formatCapitalLiveTradingOperatorAutoDeactivateReceiptGateStatus",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "buildCapitalLiveTradingOperatorAutoDeactivateReceiptPrompt",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital_live_trading_operator_auto_deactivate_receipt_gate",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "refreshCapitalLiveTradingOperatorAutoDeactivateReceiptGate",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital:live-trading:operator:auto-deactivate:receipt",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "post_task_receipt_gate_refresh", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_live_trading_operator_auto_deactivate_receipt_refresh",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "liveAutoDeactivateReceipt=", "controlled task runner");
  await assertTextContains(runnerPath, "回關收據=", "controlled task runner");
  await assertTextContains(runnerPath, "receiptPrompt=", "controlled task runner");
  await assertTextContains(runnerPath, "回關收據命令=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "live_auto_deactivate_receipt_prompt",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "live_auto_deactivate_receipt_command",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "verify_receipt_gate", "controlled task runner");
  await assertTextContains(runnerPath, "pendingExplicitExecuteReceipt=", "controlled task runner");
  await assertTextContains(runnerPath, "receiptVerified=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capitalTailRiskNextCommandMachineLine",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "tailRiskNext=", "controlled task runner");
  await assertTextContains(runnerPath, "尾風險下一步=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capitalRiskResizedRejectionPublishMachineLine",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "riskResizedReject=", "controlled task runner");
  await assertTextContains(runnerPath, "縮風險淘汰=", "controlled task runner");
  await assertTextContains(runnerPath, "paperOrderMode", "controlled task runner");
  await assertTextContains(runnerPath, "orderMode=", "controlled task runner");
  await assertTextContains(runnerPath, "下單模式=", "controlled task runner");
  await assertTextContains(runnerPath, "trading_readiness_status", "controlled task runner");
  await assertTextContains(runnerPath, "tradingReadiness=quote:", "controlled task runner");
  await assertTextContains(runnerPath, "交易就緒=報價:", "controlled task runner");
  await assertTextContains(runnerPath, "模擬:", "controlled task runner");
  await assertTextContains(runnerPath, "下單模式:", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_core_product_freshness_matrix",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "coreMatrix=", "controlled task runner");
  await assertTextContains(runnerPath, "核心商品=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "core_product_freshness_matrix_status",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "paper_order_mode_status", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "READY_BY_SERVICE_STATUS:${serviceOrderMode};sent=false/write=false",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capitalServiceStatus?.exists === true",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "下單模式=", "controlled task runner");
  await assertTextContains(runnerPath, "不可回舊價", "controlled task runner");
  await assertTextContains(runnerPath, "capital_quote_status_check", "controlled task runner");
  await assertTextContains(runnerPath, "capital:quote:status:check", "controlled task runner");
  await assertTextContains(runnerPath, "capital_service_status", "controlled task runner");
  await assertTextContains(runnerPath, "capital:service-status", "controlled task runner");
  await assertTextContains(runnerPath, "capital_service_status_check", "controlled task runner");
  await assertTextContains(runnerPath, "capital:service-status:check", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_risk_controls_live_write_observed",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    'blockers.push("capital_service_status_blocked")',
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital_domestic_quote_com_guard_recovery",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "domestic_quote_com_rpc_failed_requires_restart",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "OPENCLAW_CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "ok_superseded_by_fresh_quote", "controlled task runner");
  await assertTextContains(runnerPath, "supersededByFreshQuote", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "scripts/openclaw-capital-domestic-quote-com-guard-recovery.mjs",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "capital_overseas_stale_recovery", "controlled task runner");
  await assertTextContains(runnerPath, "overseas_stale_recovery_status", "controlled task runner");
  await assertTextContains(runnerPath, "海外修復=", "controlled task runner");
  await assertTextContains(runnerPath, "overseasRecovery=", "controlled task runner");
  await assertTextContains(runnerPath, "--execute-if-safe", "controlled task runner");
  await assertTextContains(runnerPath, "RECOVERY_EXECUTED_READY", "controlled task runner");
  await assertTextContains(runnerPath, "RECOVERY_EXECUTED_BLOCKED", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "openclaw-capital-overseas-stale-recovery-latest.json",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "openclaw-capital-overseas-stale-recovery.mjs",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "OPENCLAW_CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "recommended.target !== taskId", "controlled task runner");
  await assertTextContains(runnerPath, "paper_hft_fill_simulation", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital:paper-hft:fill-simulation",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "paper_hft_strategy_evaluate", "controlled task runner");
  await assertTextContains(runnerPath, "capital:paper-hft:evaluate", "controlled task runner");
  await assertTextContains(runnerPath, "paper_hft_auto_review", "controlled task runner");
  await assertTextContains(runnerPath, "capital:paper-hft:auto-review", "controlled task runner");
  await assertTextContains(runnerPath, "strategy_tail_risk_repair", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital:strategy:tail-risk-repair",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "paper_loop_error_repair", "controlled task runner");
  await assertTextContains(runnerPath, "capital:paper-loop:error-repair", "controlled task runner");
  await assertTextContains(runnerPath, "strategy_bar_accumulator", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital:strategy:bar-accumulator",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "strategy_engine", "controlled task runner");
  await assertTextContains(runnerPath, "capital:strategy:engine", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital:strategy:equity-position-sizer:check",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "capital-hft:strategy:equity-position-sizer:check",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "strategy_fill_simulation", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital:strategy:fill-simulation",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "capital_telegram_owner_check", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "capital_telegram_owner_contract_check",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "capital:telegram:owner", "controlled task runner");
  await assertTextContains(runnerPath, "capital:telegram:owner:check", "controlled task runner");
  await assertTextContains(runnerPath, "capital-telegram-owner-check", "controlled task runner");
  await assertTextContains(runnerPath, "telegramOwner=", "controlled task runner");
  await assertTextContains(runnerPath, "Telegram入口=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "okxCurrentReadinessRefreshWorkflow",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "okxRefresh=", "controlled task runner");
  await assertTextContains(runnerPath, "OKX刷新=", "controlled task runner");
  await assertTextContains(runnerPath, "okx_refresh_workflow", "controlled task runner");
  await assertTextContains(runnerPath, "okx_refresh_no_order_write", "controlled task runner");
  await assertTextContains(runnerPath, "noOrderWrite", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "okx_heartbeat_publish_token_counts",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "OKX心跳計數=", "controlled task runner");
  await assertTextContains(runnerPath, "schedulerNextRunAt=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "okx_heartbeat_scheduler_next_run_at",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "messageTokenCountsSummaryZhTw", "controlled task runner");
  await assertTextContains(runnerPath, "noOrderWrite=true=4", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "本地執行器=${tradingShortcutsStatus.capitalLocalExecutorDispatchPublishMachineLine}",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "positionSnapshot", "controlled task runner");
  await assertTextContains(runnerPath, "collectCardFrameworkReport", "controlled task runner");
  await assertTextContains(runnerPath, "buildProposalOnlyPlan", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "CARD_FRAMEWORK_PREFLIGHT_COMMAND",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "card_framework_preflight", "controlled task runner");
  await assertTextContains(runnerPath, "BLOCKED_CARD_FRAMEWORK", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "resolveNextSafeTaskCardIdFromGraph",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "next_safe_task.card_id", "controlled task runner");
  await assertTextContains(runnerPath, "CARD_FRAMEWORK_GRAPH_REL", "controlled task runner");
  await assertTextContains(runnerPath, "RESOLVER_CANDIDATES_REPORT_REL", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "openclaw-controlled-task-runner-next-safe-card-proposal-latest.json",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "next_safe_task_card_proposal", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "resolveNextSafeTaskResolverCandidate",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "resolver_candidates_report", "controlled task runner");
  await assertTextContains(runnerPath, "resolver_candidate_id", "controlled task runner");
  await assertTextContains(runnerPath, "resolver_candidate_report_path", "controlled task runner");
  await assertTextContains(runnerPath, "planned_only", "controlled task runner");
  await assertTextContains(runnerPath, "same_case_rerun", "controlled task runner");
  await assertTextContains(runnerPath, "simulationIterations: 1000", "controlled task runner");
  await assertTextContains(runnerPath, "DMAD_TIMEOUT_SMOKE_GATE_COMMAND", "controlled task runner");
  await assertTextContains(runnerPath, "buildDmadValidationHint", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "dmad_validation_hint", "controlled task runner");
  await assertTextContains(runnerPath, "dmad_validation_command", "controlled task runner");
  await assertTextContains(runnerPath, "dmad_validation_gate", "controlled task runner");
  await assertTextContains(runnerPath, "buildDmadPublishStatus", "controlled task runner");
  await assertTextContains(runnerPath, "dmad_publish_status", "controlled task runner");
  await assertTextContains(runnerPath, "- dmad_publish_status:", "controlled task runner");
  await assertTextContains(runnerPath, "dmad_publish_status=", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "machine_line=${payload.machineLine}",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "nextSafe=${task.id}", "controlled task runner");
  await assertTextContains(
    runnerPath,
    "resolvedDmadPublishStatus.machineLine",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "${dmadPublishStatus.machineLine} | next=",
    "controlled task runner",
  );
  await assertTextContains(
    runnerPath,
    "DMAD發布=${dmadPublishStatus.machineLine}",
    "controlled task runner",
  );
  await assertTextContains(runnerPath, "dmadGate=", "controlled task runner");
  await assertTextContains(runnerPath, "okxContract=", "controlled task runner");
  await assertTextContains(runnerPath, "summaryOkxContract=", "controlled task runner");
  await assertTextContains(runnerPath, "upstreamSchedulerNextRunAt", "controlled task runner");
  await assertTextContains(runnerPath, "DMAD=", "controlled task runner");
  await assertTextContains(publishPath, "dmadGate", "controlled task runner telegram publish");
  await assertTextContains(publishPath, "DMAD=", "controlled task runner telegram publish");
  await assertTextContains(
    inventoryPath,
    "openclaw-controlled-task-runner-telegram-latest.md",
    "autonomous inventory",
  );
  await assertTextContains(inventoryPath, "Text contract is valid", "autonomous inventory");
  await assertTextContains(
    inventoryPath,
    "- dmad_publish_status: dmadPublish=verified",
    "autonomous inventory",
  );
  await assertTextContains(inventoryPath, "summaryOkxContract=true", "autonomous inventory");

  const packageJson = await readPackageJson(repoRoot);
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:next-safe",
    "scripts/openclaw-controlled-task-runner.mjs --next-safe",
  );
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:run",
    "scripts/openclaw-controlled-task-runner.mjs --run",
  );
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:watch",
    "scripts/openclaw-controlled-task-runner-watch.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "autonomous:controlled:watch:once",
    "scripts/openclaw-controlled-task-runner-watch.mjs --once --json --task controlled_task_runner_check",
  );
  assertScriptContains(
    packageJson.scripts,
    "check:openclaw-controlled-task-runner",
    "scripts/check-openclaw-controlled-task-runner.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:quote:status",
    "scripts/openclaw-capital-quote-status.mjs --write-state --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:overseas-stale-recovery",
    "scripts/openclaw-capital-overseas-stale-recovery.mjs --write-state --simulate 500 --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:overseas-stale-recovery:check",
    "scripts/check-capital-overseas-stale-recovery.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:fill-simulation",
    "scripts/openclaw-capital-paper-fill-simulator.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:fill-simulation:check",
    "scripts/check-capital-paper-fill-simulator.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:paper-hft:fill-simulation",
    "scripts/openclaw-capital-paper-fill-simulator.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:evaluate",
    "scripts/openclaw-capital-paper-strategy-evaluator.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:evaluate:check",
    "scripts/check-capital-paper-strategy-evaluator.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:paper-hft:evaluate",
    "scripts/openclaw-capital-paper-strategy-evaluator.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:auto-review",
    "scripts/openclaw-capital-paper-auto-review.mjs --write-state --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-hft:auto-review:check",
    "scripts/check-capital-paper-auto-review.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:paper-hft:auto-review",
    "scripts/openclaw-capital-paper-auto-review.mjs --write-state --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:paper-hft:auto-review:check",
    "scripts/check-capital-paper-auto-review.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-loop:error-repair",
    "scripts/openclaw-capital-paper-error-repair.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:paper-loop:error-repair:check",
    "scripts/check-capital-paper-error-repair.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:paper-loop:error-repair",
    "scripts/openclaw-capital-paper-error-repair.mjs --json",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:bar-accumulator",
    "scripts/openclaw-capital-bar-accumulator.mjs --symbol tx-front",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:strategy:bar-accumulator",
    "scripts/openclaw-capital-bar-accumulator.mjs --symbol tx-front",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:engine",
    "scripts/openclaw-capital-strategy-engine.mjs --symbol tx-front",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:engine:check",
    "scripts/check-capital-strategy-engine.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:equity-position-sizer:check",
    "scripts/check-capital-strategy-equity-position-sizer.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:strategy:engine",
    "scripts/openclaw-capital-strategy-engine.mjs --symbol tx-front",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:strategy:equity-position-sizer:check",
    "scripts/check-capital-strategy-equity-position-sizer.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:fill-simulation",
    "scripts/openclaw-capital-strategy-fill-simulator.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital:strategy:fill-simulation:check",
    "scripts/check-capital-strategy-fill-simulation.mjs",
  );
  assertScriptContains(
    packageJson.scripts,
    "capital-hft:strategy:fill-simulation",
    "scripts/openclaw-capital-strategy-fill-simulator.mjs",
  );

  process.stdout.write("OPENCLAW_CONTROLLED_TASK_RUNNER_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw controlled task runner check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
