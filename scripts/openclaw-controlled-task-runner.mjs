#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectCardFrameworkReport } from "./check-openclaw-card-framework.mjs";
import { buildProposalOnlyPlan } from "./generate-openclaw-card-module-dry-run.mjs";
import { collectAutonomousInventory } from "./openclaw-autonomous-inventory.mjs";

const RUNNER_SCHEMA = "openclaw.controlled-task-runner.report.v1";
const STATE_SCHEMA = "openclaw.controlled-task-runner.state.v1";
const TELEGRAM_SUMMARY_SCHEMA = "openclaw.controlled-task-runner.telegram-summary.v1";
const STATE_DIR_REL = "reports/hermes-agent/state";
const LATEST_REPORT_NAME = "openclaw-controlled-task-runner-latest.json";
const LATEST_TELEGRAM_JSON_NAME = "openclaw-controlled-task-runner-telegram-latest.json";
const LATEST_TELEGRAM_MD_NAME = "openclaw-controlled-task-runner-telegram-latest.md";
const TELEGRAM_TRADING_SHORTCUTS_REPORT_NAME = "openclaw-telegram-trading-shortcuts-latest.json";
const TRADINGAGENTS_SUMMARY_REPORT_NAME = "openclaw-tradingagents-summary-latest.json";
const TELEGRAM_PUBLISH_REPORT_NAME = "openclaw-controlled-task-runner-telegram-publish-latest.json";
const TELEGRAM_PUBLISH_BRIDGE_REPORT_NAME =
  "openclaw-controlled-task-runner-telegram-publish-bridge-latest.json";
const TELEGRAM_PUBLISH_SCRIPT_REL = "scripts/openclaw-controlled-task-runner-telegram-publish.mjs";
const TELEGRAM_PUBLISH_TARGET_ENV = "OPENCLAW_TELEGRAM_STATUS_TARGET";
const TELEGRAM_PUBLISH_ENABLE_ENV = "OPENCLAW_CONTROLLED_RUNNER_TELEGRAM_PUBLISH";
const TELEGRAM_PUBLISH_MODE_ENV = "OPENCLAW_CONTROLLED_RUNNER_TELEGRAM_PUBLISH_MODE";
const TELEGRAM_SENT_MESSAGES_REL =
  ".openclaw/agents/main/sessions/sessions.json.telegram-sent-messages.json";
const RUNNER_STATE_REL = ".openclaw/automation/openclaw-controlled-task-runner-state.json";
const QUOTE_STATUS_REL = ".openclaw/quote/capital-quote-status.json";
const CAPITAL_SERVICE_STATUS_REL = ".openclaw/quote/capital-service-status.json";
const CAPITAL_TELEGRAM_OWNER_CHECK_REL = ".openclaw/quote/capital-telegram-owner-check.json";
const CAPITAL_QUICK_QUOTE_LATEST_PATH_ENV = "OPENCLAW_CAPITAL_QUICK_QUOTE_LATEST_PATH";
const CAPITAL_QUICK_QUOTE_LATEST_DEFAULT =
  "D:\\群益及元大API\\CapitalHftService\\state\\capital_quick_quote_latest.json";
const CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH_ENV = "OPENCLAW_CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH";
const CAPITAL_DOMESTIC_QUOTE_COM_GUARD_DEFAULT =
  "D:\\群益及元大API\\CapitalHftService\\state\\capital_domestic_quote_com_guard.json";
const CAPITAL_DOMESTIC_QUOTE_COM_GUARD_BLOCKER = "domestic_quote_com_rpc_failed_requires_restart";
const CAPITAL_OVERSEAS_STALE_RECOVERY_REPORT_REL =
  "reports/hermes-agent/state/openclaw-capital-overseas-stale-recovery-latest.json";
const CAPITAL_OVERSEAS_STALE_TARGET_PRODUCT_IDS = new Set(["a50-hot", "cad-hot", "crude-oil-hot"]);
const CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH_ENV = "OPENCLAW_CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH";
const CAPITAL_FRESH_QUOTE_GATE_LATEST_DEFAULT =
  "D:\\群益及元大API\\CapitalHftService\\state\\capital_fresh_quote_gate_latest.json";
const CAPITAL_PAPER_ASSISTANT_STATE_REL = ".openclaw/ui/capital-paper-assistant-state.json";
const CAPITAL_PAPER_FILL_SIMULATION_REL = ".openclaw/trading/capital-paper-fill-simulation.json";
const CAPITAL_PAPER_STRATEGY_EVALUATION_REL =
  ".openclaw/trading/capital-paper-strategy-evaluation.json";
const CAPITAL_PAPER_AUTO_REVIEW_REL = ".openclaw/trading/capital-paper-auto-review-latest.json";
const CAPITAL_PAPER_ERROR_REPAIR_REL = ".openclaw/trading/capital-paper-error-repair-latest.json";
const CAPITAL_STRATEGY_FILL_SIMULATION_REL =
  ".openclaw/trading/capital-strategy-fill-simulation.json";
const CAPITAL_CORE_PRODUCT_FRESHNESS_MATRIX_REL =
  ".openclaw/quote/capital-core-product-freshness-matrix.json";
const CAPITAL_LIVE_TRADING_APPROVAL_SUMMARY_REL =
  "reports/hermes-agent/state/openclaw-capital-live-trading-approval-summary-latest.json";
const CAPITAL_LIVE_TRADING_APPROVAL_TELEGRAM_PUBLISH_REL =
  "reports/hermes-agent/state/openclaw-capital-live-trading-approval-telegram-publish-dry-run-latest.json";
const CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_REL =
  "reports/hermes-agent/state/openclaw-capital-live-trading-operator-auto-deactivate-latest.json";
const CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_RECEIPT_GATE_REL =
  "reports/hermes-agent/state/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json";
const BLACKBOX_AUTONOMY_REPORT_REL =
  "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json";
const BLACKBOX_SYNC_REPORT_REL = "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json";
const TEST_CHANGED_CLOSURE_REPORT_REL =
  "reports/hermes-agent/state/openclaw-test-changed-closure-latest.json";
const HERMES_NUWA_BRIDGE_REPORT_REL = "reports/hermes-nuwa-bridge-latest.json";
const CARD_FRAMEWORK_GRAPH_REL = "reports/openclaw-card-framework-graph.json";
const RESOLVER_CANDIDATES_REPORT_REL = "reports/openclaw-resolver-candidates-latest.json";
const NEXT_SAFE_CARD_PROPOSAL_REPORT_NAME =
  "openclaw-controlled-task-runner-next-safe-card-proposal-latest.json";
const TEST_CHANGED_CLOSURE_TIMEOUT_BACKOFF_MS = 60 * 60 * 1000;
const EPERM_FALLBACK_ERROR_CODES = new Set(["EPERM", "SPAWN_ERROR", "SPAWN_THROWN"]);
const INVALID_TEXT_SENTINELS = new Set(["none", "unknown", "undefined", "null", "n/a"]);
const CARD_FRAMEWORK_PREFLIGHT_COMMAND = "pnpm check:openclaw-card-framework";
const DMAD_TIMEOUT_SMOKE_GATE_COMMAND =
  "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full";
const DMAD_TIMEOUT_SMOKE_GATE_ID = "timeout-smoke:gate:ultra:verify:ultra:full";
const DMAD_TIMEOUT_SMOKE_GATE_SOURCE = "docs/codex-task-dmad-speedup.md";

const MARKET_MONITOR_TASKS = [
  {
    id: "capital_quote_status",
    label: "CapitalHftService quote status",
    command: "pnpm",
    args: ["capital:quote:status"],
  },
  {
    id: "capital_service_status",
    label: "CapitalHftService service status",
    command: "pnpm",
    args: ["capital:service-status"],
  },
  {
    id: "capital_telegram_owner_check",
    label: "CapitalHftService Telegram single-owner check",
    command: "pnpm",
    args: ["capital:telegram:owner"],
  },

  {
    id: "autonomous_inventory_check",
    label: "Autonomous inventory check",
    command: "pnpm",
    args: ["autonomous:inventory:check"],
  },

  {
    id: "paper_hft_fill_simulation",
    label: "Paper HFT fill simulation (learning quality)",
    command: "pnpm",
    args: ["capital:paper-hft:fill-simulation"],
  },

  {
    id: "paper_hft_strategy_evaluate",
    label: "Paper HFT strategy evaluator (AI judge)",
    command: "pnpm",
    args: ["capital:paper-hft:evaluate"],
  },

  {
    id: "paper_hft_auto_review",
    label: "Paper HFT auto-review (candidate → approved_paper)",
    command: "pnpm",
    args: ["capital:paper-hft:auto-review"],
  },
  {
    id: "strategy_tail_risk_repair",
    label: "Strategy tail-risk repair plan (paper-only)",
    command: "pnpm",
    args: ["capital:strategy:tail-risk-repair"],
  },

  {
    id: "paper_loop_error_repair",
    label: "Paper loop error repair (自我修復診斷)",
    command: "pnpm",
    args: ["capital:paper-loop:error-repair"],
  },
  {
    id: "strategy_bar_accumulator",
    label: "Strategy bar accumulator (每日K棒累積)",
    command: "pnpm",
    args: ["capital:strategy:bar-accumulator"],
  },
  {
    id: "strategy_engine",
    label: "Strategy engine (ORB/EMA/VWAP 信號產生)",
    command: "pnpm",
    args: ["capital:strategy:engine"],
  },
  {
    id: "strategy_fill_simulation",
    label: "Strategy fill simulation (方向性信號損益評估)",
    command: "pnpm",
    args: ["capital:strategy:fill-simulation"],
  },
];

const RESILIENCE_HARDENING_TASKS = [
  {
    id: "blackbox_autonomy_tick",
    label: "OpenClaw blackbox autonomy single tick (paper-only)",
    command: "node",
    args: ["scripts/openclaw-blackbox-autonomy-tick.mjs", "--write-state", "--json"],
  },
  {
    id: "openclaw-d-big-repair-check",
    label: "OpenClaw D big repair check",
    command: "pnpm",
    args: ["autonomous:inventory:check"],
  },
  {
    id: "autonomous_inventory_check",
    label: "Autonomous inventory check",
    command: "pnpm",
    args: ["autonomous:inventory:check"],
  },
  {
    id: "controlled_task_runner_check",
    label: "Controlled task runner contract check",
    command: "pnpm",
    args: ["check:openclaw-controlled-task-runner"],
  },
  {
    id: "test_changed_closure_contract_check",
    label: "Test changed closure contract check",
    command: "pnpm",
    args: ["check:openclaw-test-changed-closure"],
  },
  {
    id: "test_changed_closure",
    label: "Test changed closure runner",
    command: "pnpm",
    args: ["autonomous:test:changed:closure"],
  },
  {
    id: "capital_quote_status_check",
    label: "CapitalHftService quote status contract check",
    command: "pnpm",
    args: ["capital:quote:status:check"],
  },
  {
    id: "capital_service_status_check",
    label: "CapitalHftService service status contract check",
    command: "pnpm",
    args: ["capital:service-status:check"],
  },
  {
    id: "capital_live_trading_operator_auto_deactivate",
    label: "Capital live/write risk-controls observed blocker report",
    command: "pnpm",
    args: ["capital:live-trading:operator:auto-deactivate"],
  },
  {
    id: "capital_live_trading_operator_auto_deactivate_receipt_check",
    label: "Capital live/write auto-deactivate receipt pending check",
    command: "pnpm",
    args: ["capital:live-trading:operator:auto-deactivate:receipt:check"],
  },
  {
    id: "capital_domestic_quote_com_guard_recovery",
    label: "CapitalHftService domestic quote COM guard no-order recovery",
    command: "node",
    args: [
      "scripts/openclaw-capital-domestic-quote-com-guard-recovery.mjs",
      "--write-state",
      "--simulate",
      "500",
      "--execute-if-safe",
      "--json",
    ],
  },
  {
    id: "capital_overseas_stale_recovery",
    label: "CapitalHftService overseas hot-month stale no-order recovery",
    command: "node",
    args: [
      "scripts/openclaw-capital-overseas-stale-recovery.mjs",
      "--write-state",
      "--simulate",
      "500",
      "--execute-if-safe",
      "--json",
    ],
  },
  {
    id: "capital_telegram_owner_contract_check",
    label: "CapitalHftService Telegram owner contract check",
    command: "pnpm",
    args: ["capital:telegram:owner:check"],
  },
  // ── Hermes → nuwa.db 橋接（將受控任務學習記錄同步到 DMAD 先驗知識庫）──────
  {
    id: "hermes-nuwa-bridge",
    label: "Hermes 受控任務學習 → nuwa.db 橋接（DMAD 先驗同步）",
    command: "pnpm",
    args: ["hermes:nuwa-bridge"],
  },
  // ── 學習報告每日健康閘 ─────────────────────────────────────────────────────
  {
    id: "learning-daily-check",
    label: "OpenClaw 學習報告每日新鮮度閘（paper HFT learning summary）",
    command: "pnpm",
    args: ["capital-hft:paper-hft:learning:summary"],
  },
  // ── DMAD 三方辯論自我進化任務（建立在 OpenClaw 閉環內）─────────────────────
  {
    id: "dmad-smoke-test",
    label: "DMAD 三方辯論 smoke test（自動進化閘）",
    command: "pnpm",
    args: ["dmad:smoke-test"],
  },
  {
    id: "dmad-meta-learn",
    label: "DMAD 元學習校準（每日自動調整閾值）",
    command: "pnpm",
    args: ["dmad:meta-learn"],
  },
  {
    id: "dmad-trend",
    label: "DMAD 趨勢分析報告更新",
    command: "pnpm",
    args: ["dmad:trend"],
  },
];

const ALL_TASKS = [...MARKET_MONITOR_TASKS, ...RESILIENCE_HARDENING_TASKS];

const TASK_DIRECT_FALLBACKS = {
  autonomous_inventory_check: {
    mode: "in_process",
  },
  controlled_task_runner_check: {
    mode: "in_process",
  },
  test_changed_closure_contract_check: {
    mode: "in_process",
  },
  capital_quote_status_check: {
    mode: "in_process",
  },
  capital_service_status_check: {
    mode: "in_process",
  },
  capital_domestic_quote_com_guard_recovery: {
    mode: "in_process",
  },
  capital_overseas_stale_recovery: {
    mode: "in_process",
  },
  capital_telegram_owner_check: {
    mode: "in_process",
  },
  capital_telegram_owner_contract_check: {
    mode: "in_process",
  },
};

function usage() {
  return [
    "Usage:",
    "  node scripts/openclaw-controlled-task-runner.mjs --next-safe [--json]",
    "  node scripts/openclaw-controlled-task-runner.mjs --run [--json]",
    "  node scripts/openclaw-controlled-task-runner.mjs --task <task_id> [--json]",
    "",
    `Task IDs: ${ALL_TASKS.map((task) => task.id).join(", ")}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    mode: "next-safe",
    json: false,
    taskId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--next-safe") {
      options.mode = "next-safe";
      continue;
    }
    if (arg === "--run") {
      options.mode = "run";
      continue;
    }
    if (arg === "--task") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--task requires a task id");
      }
      options.taskId = next;
      options.mode = "run";
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.mode = "help";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeTextValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (INVALID_TEXT_SENTINELS.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function tokenizeComparableText(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildCardGraphNodeIndex(graph) {
  const nodes = Array.isArray(graph?.graph?.nodes) ? graph.graph.nodes : [];
  return nodes
    .filter((node) => ["component", "module", "capability"].includes(node?.type))
    .map((node) => {
      const tokenSet = new Set([
        ...tokenizeComparableText(node?.id ?? ""),
        ...tokenizeComparableText(node?.label ?? ""),
        ...tokenizeComparableText(node?.nextSafeTask ?? ""),
        ...tokenizeComparableText(node?.contract ?? ""),
      ]);
      return {
        id: typeof node?.id === "string" ? node.id : "",
        tokenSet,
      };
    })
    .filter((entry) => entry.id.length > 0);
}

function findCardIdByTokens(cardIndex, requiredTokens) {
  const normalizedRequired = requiredTokens
    .map((token) => String(token).toLowerCase().trim())
    .filter((token) => token.length > 0);
  if (normalizedRequired.length === 0) {
    return null;
  }
  const matched = cardIndex.find((entry) =>
    normalizedRequired.every((token) => entry.tokenSet.has(token)),
  );
  return matched?.id ?? null;
}

function hasAnyTaskToken(taskTokenSet, tokens) {
  return tokens.some((token) => taskTokenSet.has(token));
}

function cardNodeExists(graph, cardId) {
  const normalizedCardId = normalizeTextValue(cardId);
  if (!normalizedCardId) {
    return false;
  }
  const nodes = Array.isArray(graph?.graph?.nodes) ? graph.graph.nodes : [];
  return nodes.some((node) => normalizeTextValue(node?.id) === normalizedCardId);
}

export function resolveNextSafeTaskCardIdFromGraph(taskId, graph) {
  const normalizedTaskId = normalizeTextValue(taskId);
  if (!normalizedTaskId) {
    return null;
  }
  if (normalizedTaskId.startsWith("card:")) {
    const fromTaskId = normalizedTaskId.slice("card:".length).trim();
    return fromTaskId.length > 0 ? fromTaskId : null;
  }

  const cardIndex = buildCardGraphNodeIndex(graph);
  if (cardIndex.length === 0) {
    return null;
  }

  const cardRoles = {
    controlledRunner: findCardIdByTokens(cardIndex, ["controlled", "runner"]),
    validationGate: findCardIdByTokens(cardIndex, ["validation", "gate"]),
    channel: findCardIdByTokens(cardIndex, ["component", "channel"]),
    tradingRuntime: findCardIdByTokens(cardIndex, ["trading", "runtime"]),
    tradingRiskGate: findCardIdByTokens(cardIndex, ["trading", "risk", "gate"]),
    memory: findCardIdByTokens(cardIndex, ["component", "memory"]),
    reportState: findCardIdByTokens(cardIndex, ["report", "state"]),
  };

  const taskTokenSet = new Set(tokenizeComparableText(normalizedTaskId));

  if (hasAnyTaskToken(taskTokenSet, ["controlled", "runner"])) {
    return cardRoles.controlledRunner ?? cardRoles.validationGate ?? cardRoles.reportState;
  }

  if (hasAnyTaskToken(taskTokenSet, ["telegram", "owner", "channel"])) {
    return cardRoles.channel ?? cardRoles.controlledRunner ?? cardRoles.validationGate;
  }

  if (hasAnyTaskToken(taskTokenSet, ["approval", "promote", "promotion", "allowlist", "kill"])) {
    return cardRoles.tradingRiskGate ?? cardRoles.tradingRuntime ?? cardRoles.validationGate;
  }

  if (
    hasAnyTaskToken(taskTokenSet, [
      "capital",
      "quote",
      "service",
      "strategy",
      "paper",
      "trade",
      "hft",
    ])
  ) {
    return cardRoles.tradingRuntime ?? cardRoles.tradingRiskGate ?? cardRoles.validationGate;
  }

  if (hasAnyTaskToken(taskTokenSet, ["nuwa", "bridge", "memory", "learn"])) {
    return cardRoles.memory ?? cardRoles.reportState ?? cardRoles.validationGate;
  }

  if (hasAnyTaskToken(taskTokenSet, ["trend", "report", "summary"])) {
    return cardRoles.reportState ?? cardRoles.memory ?? cardRoles.validationGate;
  }

  if (hasAnyTaskToken(taskTokenSet, ["test", "check", "contract", "closure", "inventory"])) {
    return cardRoles.validationGate ?? cardRoles.controlledRunner ?? cardRoles.reportState;
  }

  return (
    cardRoles.validationGate ??
    cardRoles.controlledRunner ??
    cardRoles.reportState ??
    cardIndex[0]?.id ??
    null
  );
}

export function resolveNextSafeTaskProposalCard(taskId, nextSafeTaskCardId, graph) {
  const normalizedTaskCardId = normalizeTextValue(nextSafeTaskCardId);
  if (normalizedTaskCardId && cardNodeExists(graph, normalizedTaskCardId)) {
    return {
      cardId: normalizedTaskCardId,
      source: "next_safe_task.card_id",
    };
  }

  const mappedCardId = resolveNextSafeTaskCardIdFromGraph(taskId, graph);
  if (mappedCardId) {
    return {
      cardId: mappedCardId,
      source: normalizedTaskCardId
        ? "task_id_mapping_fallback_from_invalid_next_safe_task.card_id"
        : "task_id_mapping",
    };
  }

  return {
    cardId: null,
    source: normalizedTaskCardId ? "invalid_next_safe_task.card_id" : "task_id_mapping",
  };
}

export function resolveNextSafeTaskResolverCandidate(taskId, resolverReport) {
  const normalizedTaskId = normalizeTextValue(taskId);
  const normalizedReportNextTaskId = normalizeTextValue(resolverReport?.nextSafeTask?.id);
  const candidates = Array.isArray(resolverReport?.candidates) ? resolverReport.candidates : [];
  if ((!normalizedTaskId && !normalizedReportNextTaskId) || candidates.length === 0) {
    return null;
  }

  const candidate = candidates.find((entry) => {
    const candidateId = normalizeTextValue(entry?.id);
    const blockerId = normalizeTextValue(entry?.blocker?.id);
    return (
      candidateId === normalizedTaskId ||
      blockerId === normalizedTaskId ||
      candidateId === normalizedReportNextTaskId ||
      blockerId === normalizedReportNextTaskId
    );
  });
  if (!candidate) {
    return null;
  }

  const proposedCommand = candidate.proposedCommand ?? {};
  const sameCaseRerun = candidate.sameCaseRerun ?? {};
  const risk = candidate.risk ?? {};
  const sourceEvidence = Array.isArray(candidate.sourceEvidence)
    ? candidate.sourceEvidence.map((entry) => ({
        sourceId: normalizeTextValue(entry?.sourceId),
        sourceType: normalizeTextValue(entry?.sourceType),
        trustLevel: normalizeTextValue(entry?.trustLevel),
        path: normalizeTextValue(entry?.path),
      }))
    : [];

  return {
    id: normalizeTextValue(candidate.id),
    status: normalizeTextValue(candidate.status),
    priority: normalizeTextValue(candidate.priority),
    blocker_id: normalizeTextValue(candidate.blocker?.id),
    risk_level: normalizeTextValue(risk.level),
    runtime_mutation_allowed: risk.runtimeMutationAllowed === true,
    external_write_allowed: risk.externalWriteAllowed === true,
    live_trading_allowed: risk.liveTradingAllowed === true,
    requires_human_review_before_apply: risk.requiresHumanReviewBeforeApply === true,
    planned_only: proposedCommand.mode === "planned_only",
    auto_execute: proposedCommand.autoExecute === true,
    command: normalizeTextValue(proposedCommand.command),
    same_case_rerun: Array.isArray(sameCaseRerun.commands) ? sameCaseRerun.commands : [],
    rollback_path: Array.isArray(candidate.rollbackPath) ? candidate.rollbackPath : [],
    source_evidence: sourceEvidence,
    report_path: RESOLVER_CANDIDATES_REPORT_REL,
  };
}

async function queryNuwaPatterns(_lane) {
  try {
    const nuwaDbPath = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
      "..",
      "extensions",
      "evolution-learning",
      ".claude",
      "evolution-state",
      "nuwa.db",
    );
    const { existsSync } = await import("node:fs");
    if (!existsSync(nuwaDbPath)) {
      return [];
    }
    const { openDb } = await import("./lib/sqlite-compat.mjs");
    const db = await openDb(nuwaDbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    const rows = db
      .prepare(`
      SELECT slug, target, confidence, decay_score
      FROM patterns
      WHERE frozen = 0 AND decay_score > 0.5
      ORDER BY decay_score DESC
      LIMIT 5
    `)
      .all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

export function isControlledTaskCompleted(taskId, context = {}) {
  const normalizedTaskId = normalizeTextValue(taskId);
  const serviceStatus = context.capitalServiceStatus ?? context.serviceStatus ?? null;
  if (
    normalizedTaskId === "capital_quote_status" ||
    normalizedTaskId === "capital_service_status"
  ) {
    return isCapitalServiceStatusAuthoritativeReady(serviceStatus);
  }
  if (
    normalizedTaskId === "capital_telegram_owner_check" ||
    normalizedTaskId === "capital_telegram_owner_contract_check"
  ) {
    const ownerCheck = context.capitalTelegramOwnerCheck ?? null;
    return (
      ownerCheck?.ready === true &&
      ownerCheck?.readOnly === true &&
      ownerCheck?.liveTradingEnabled === false &&
      ownerCheck?.writeTradingEnabled === false
    );
  }
  if (normalizedTaskId === "capital_overseas_stale_recovery") {
    const overseasRecovery = context.capitalOverseasStaleRecovery ?? null;
    return (
      isCapitalServiceStatusAuthoritativeReady(serviceStatus) ||
      (overseasRecovery?.ready === true &&
        (overseasRecovery?.staleTargets?.length ?? 0) === 0 &&
        overseasRecovery?.sentOrder === false &&
        overseasRecovery?.writeBrokerOrders === false &&
        overseasRecovery?.brokerWriteAttempted === false)
    );
  }
  if (normalizedTaskId === "capital_domestic_quote_com_guard_recovery") {
    const domesticGuard = context.capitalDomesticQuoteComGuard ?? null;
    const freshQuoteGate = context.capitalFreshQuoteGate ?? null;
    return (
      isCapitalServiceStatusAuthoritativeReady(serviceStatus) ||
      domesticGuard?.restartRequired !== true ||
      freshQuoteGate?.ready === true
    );
  }
  if (normalizedTaskId === "autonomous_inventory_check") {
    return context.autonomousInventory?.summary?.ok === true;
  }
  if (normalizedTaskId === "paper_hft_fill_simulation") {
    const fillSimulation = context.capitalPaperFillSimulation ?? null;
    return (
      fillSimulation?.exists === true &&
      fillSimulation?.status === "ok" &&
      fillSimulation?.readOnly === true &&
      fillSimulation?.liveTradingEnabled === false &&
      fillSimulation?.writeTradingEnabled === false &&
      fillSimulation?.brokerOrderPathEnabled === false
    );
  }
  if (normalizedTaskId === "paper_hft_strategy_evaluate") {
    const strategyEvaluation = context.capitalPaperStrategyEvaluation ?? null;
    return (
      strategyEvaluation?.exists === true &&
      strategyEvaluation?.status === "evaluated" &&
      strategyEvaluation?.readOnly === true &&
      strategyEvaluation?.liveTradingEnabled === false &&
      strategyEvaluation?.writeTradingEnabled === false &&
      strategyEvaluation?.brokerOrderPathEnabled === false
    );
  }
  if (normalizedTaskId === "paper_hft_auto_review") {
    const autoReview = context.capitalPaperAutoReview ?? null;
    return (
      autoReview?.exists === true &&
      (autoReview?.status === "already_approved" || autoReview?.status === "promoted") &&
      autoReview?.readOnly === true &&
      autoReview?.liveTradingEnabled === false &&
      autoReview?.writeTradingEnabled === false &&
      autoReview?.brokerOrderPathEnabled === false
    );
  }
  if (normalizedTaskId === "paper_loop_error_repair") {
    const errorRepair = context.capitalPaperErrorRepair ?? null;
    return (
      errorRepair?.exists === true &&
      errorRepair?.repairStatus === "healthy" &&
      errorRepair?.readOnly === true &&
      errorRepair?.liveTradingEnabled === false &&
      errorRepair?.writeTradingEnabled === false &&
      errorRepair?.brokerOrderPathEnabled === false
    );
  }
  if (normalizedTaskId === "strategy_fill_simulation") {
    const strategyFillSimulation = context.capitalStrategyFillSimulation ?? null;
    return (
      strategyFillSimulation?.exists === true &&
      (strategyFillSimulation?.status === "ok" ||
        strategyFillSimulation?.status === "historical_simulated" ||
        strategyFillSimulation?.status === "no_intents") &&
      strategyFillSimulation?.liveTradingEnabled === false &&
      strategyFillSimulation?.writeTradingEnabled === false &&
      strategyFillSimulation?.brokerOrderPathEnabled === false
    );
  }
  if (normalizedTaskId === "hermes-nuwa-bridge") {
    const bridgeReport = context.hermesNuwaBridge ?? null;
    return (
      bridgeReport?.exists === true &&
      bridgeReport?.status === "ok" &&
      (bridgeReport?.errors?.length ?? 0) === 0
    );
  }
  if (normalizedTaskId === "blackbox_autonomy_tick") {
    const blackbox = context.blackboxAutonomy ?? null;
    const blackboxSync = context.blackboxSync ?? null;
    return (
      blackbox?.exists === true &&
      blackbox?.hardStop !== true &&
      blackbox?.noOrderWrite === true &&
      blackbox?.allowLiveTrading !== true &&
      typeof blackbox?.nextSafeTask === "string" &&
      blackbox.nextSafeTask.trim().length > 0 &&
      blackboxSync?.exists === true &&
      typeof blackboxSync?.syncStatus === "string" &&
      blackboxSync.syncStatus.length > 0
    );
  }
  return false;
}

function pickNextTask(taskPool, taskId, nuwaPatterns) {
  if (!Array.isArray(taskPool) || taskPool.length === 0) {
    throw new Error("task pool must not be empty");
  }
  if (Array.isArray(nuwaPatterns) && nuwaPatterns.length > 0) {
    const recommended = nuwaPatterns.find(
      (p) => p.decay_score > 0.7 && taskPool.some((t) => t.id === p.target),
    );
    if (recommended && (recommended.target !== taskId || taskPool.length === 1)) {
      return taskPool.find((t) => t.id === recommended.target);
    }
  }
  if (!taskId) {
    return taskPool[0];
  }
  const index = taskPool.findIndex((entry) => entry.id === taskId);
  if (index < 0) {
    return taskPool[0];
  }
  return taskPool[(index + 1) % taskPool.length];
}

export function pickNextIncompleteTask(taskPool, taskId, context = {}, nuwaPatterns) {
  if (!Array.isArray(taskPool) || taskPool.length === 0) {
    throw new Error("task pool must not be empty");
  }
  const incompleteTaskPool = taskPool.filter(
    (task) => !isControlledTaskCompleted(task.id, context),
  );
  if (incompleteTaskPool.length === 0) {
    return pickNextTask(taskPool, taskId, nuwaPatterns);
  }
  return pickNextTask(incompleteTaskPool, taskId, nuwaPatterns);
}

function resolveTask(taskId) {
  if (!taskId) {
    return null;
  }
  return ALL_TASKS.find((entry) => entry.id === taskId) ?? null;
}

async function buildTestChangedClosureContractChecks() {
  const runnerPath = path.join(process.cwd(), "scripts", "openclaw-controlled-task-runner.mjs");
  const closurePath = path.join(process.cwd(), "scripts", "openclaw-test-changed-closure.mjs");
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const runnerContent = await fs.readFile(runnerPath, "utf8");
  const closureContent = await fs.readFile(closurePath, "utf8");
  const packageJson = JSON.parse(
    (await fs.readFile(packageJsonPath, "utf8")).replace(/^\uFEFF/, ""),
  );

  return {
    hasRunnerClosureContractTaskToken: runnerContent.includes(
      "test_changed_closure_contract_check",
    ),
    hasRunnerClosureContractCommandToken: runnerContent.includes(
      "check:openclaw-test-changed-closure",
    ),
    hasRunnerClosureTaskToken: runnerContent.includes("test_changed_closure"),
    hasRunnerClosureCommandToken: runnerContent.includes("autonomous:test:changed:closure"),
    hasClosureSchemaToken: closureContent.includes("openclaw.test-changed-closure.report.v1"),
    hasIgnoreBrokenPipeToken: closureContent.includes("ignoreBrokenPipe"),
    hasEpipeToken: closureContent.includes("EPIPE"),
    hasResolveSpawnCommandToken: closureContent.includes("resolveSpawnCommand"),
    hasWindowsCmdToken: closureContent.includes("cmd.exe"),
    hasPackageClosureScript:
      typeof packageJson?.scripts?.["autonomous:test:changed:closure"] === "string" &&
      packageJson.scripts["autonomous:test:changed:closure"].includes(
        "scripts/openclaw-test-changed-closure.mjs",
      ),
    hasPackageClosureCheckScript:
      typeof packageJson?.scripts?.["check:openclaw-test-changed-closure"] === "string" &&
      packageJson.scripts["check:openclaw-test-changed-closure"].includes(
        "scripts/check-openclaw-test-changed-closure.mjs",
      ),
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function buildNextSafeTaskCardProposal(repoRoot, nextSafeTaskId, nextSafeTaskCardId = null) {
  const reportPath = path.join(repoRoot, STATE_DIR_REL, NEXT_SAFE_CARD_PROPOSAL_REPORT_NAME);
  const reportPathRel = toPosix(path.relative(repoRoot, reportPath));
  const graphPath = path.join(repoRoot, CARD_FRAMEWORK_GRAPH_REL);
  const graph = await readJson(graphPath);
  const cardResolution = resolveNextSafeTaskProposalCard(nextSafeTaskId, nextSafeTaskCardId, graph);
  const cardId = cardResolution.cardId;
  const basePayload = {
    schema: "openclaw.controlled-task-runner.next-safe-card-proposal.v1",
    generatedAt: new Date().toISOString(),
    taskId: normalizeTextValue(nextSafeTaskId) ?? null,
    cardId,
    cardIdSource: cardResolution.source,
    sourceGraph: CARD_FRAMEWORK_GRAPH_REL,
    dryRunOnly: true,
  };

  if (!graph) {
    await writeJson(reportPath, {
      ...basePayload,
      status: "blocked_missing_graph",
      errorCode: "MISSING_GRAPH",
      failures: [`missing ${CARD_FRAMEWORK_GRAPH_REL}`],
      proposal: null,
    });
    return {
      status: "blocked_missing_graph",
      errorCode: "MISSING_GRAPH",
      taskId: basePayload.taskId,
      cardId,
      cardIdSource: cardResolution.source,
      reportPath: reportPathRel,
      proposalReady: false,
    };
  }

  if (!cardId) {
    await writeJson(reportPath, {
      ...basePayload,
      status: "skipped_no_card_mapping",
      errorCode: "NO_CARD_MAPPING",
      failures: ["next_safe_task has no valid card id"],
      proposal: null,
    });
    return {
      status: "skipped_no_card_mapping",
      errorCode: "NO_CARD_MAPPING",
      taskId: basePayload.taskId,
      cardId: null,
      cardIdSource: cardResolution.source,
      reportPath: reportPathRel,
      proposalReady: false,
    };
  }

  const proposalPlan = buildProposalOnlyPlan(graph, {
    cardId,
    graphPath: CARD_FRAMEWORK_GRAPH_REL,
  });
  const proposalOk = proposalPlan.ok === true;
  await writeJson(reportPath, {
    ...basePayload,
    status: proposalOk ? "proposal_ready" : "blocked_proposal_generation",
    errorCode: proposalOk ? "OK" : "PROPOSAL_GENERATION_BLOCKED",
    failures: Array.isArray(proposalPlan.failures) ? proposalPlan.failures : [],
    proposal: proposalOk ? proposalPlan.proposal : null,
    summary: proposalOk ? proposalPlan.summary : null,
  });

  return {
    status: proposalOk ? "proposal_ready" : "blocked_proposal_generation",
    errorCode: proposalOk ? "OK" : "PROPOSAL_GENERATION_BLOCKED",
    taskId: basePayload.taskId,
    cardId,
    cardIdSource: cardResolution.source,
    reportPath: reportPathRel,
    proposalReady: proposalOk,
    proposalMode: proposalOk ? (proposalPlan.proposal?.mode ?? null) : null,
    proposalSteps: proposalOk ? (proposalPlan.summary?.proposalSteps ?? null) : null,
  };
}

function nowId() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const isWindows = process.platform === "win32";
    const spawnAttempts = isWindows
      ? [
          { executable: command, commandArgs: args },
          { executable: "cmd.exe", commandArgs: ["/d", "/s", "/c", command, ...args] },
        ]
      : [{ executable: command, commandArgs: args }];

    const settle = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    const spawnAttempt = (attemptIndex) => {
      if (settled) {
        return;
      }
      const attempt = spawnAttempts[attemptIndex];
      if (!attempt) {
        settle({
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          errorCode: "SPAWN_EXHAUSTED",
        });
        return;
      }

      let advanced = false;
      const advanceToNextAttempt = () => {
        if (advanced || settled) {
          return false;
        }
        advanced = true;
        if (attemptIndex + 1 < spawnAttempts.length) {
          spawnAttempt(attemptIndex + 1);
          return true;
        }
        return false;
      };

      let child;
      try {
        child = spawn(attempt.executable, attempt.commandArgs, {
          cwd: process.cwd(),
          env: options.env ?? process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode =
          typeof error === "object" && error !== null && typeof error.code === "string"
            ? error.code
            : "SPAWN_THROWN";
        stderrChunks.push(`\n${errorMessage}`);
        if (advanceToNextAttempt()) {
          return;
        }
        settle({
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join("").trim(),
          errorCode,
        });
        return;
      }

      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        stdoutChunks.push(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
        stderrChunks.push(String(chunk));
      });
      child.once("error", (error) => {
        const errorCode =
          typeof error === "object" && error !== null && typeof error.code === "string"
            ? error.code
            : "SPAWN_ERROR";
        stderrChunks.push(`\n${error.message}`);
        if (advanceToNextAttempt()) {
          return;
        }
        settle({
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join("").trim(),
          errorCode,
        });
      });
      child.once("close", (code) => {
        if (advanced || settled) {
          return;
        }
        if (isWindows && code === -4058 && advanceToNextAttempt()) {
          return;
        }
        settle({
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          errorCode: code === 0 ? "OK" : "TASK_NON_ZERO_EXIT",
        });
      });
    };

    spawnAttempt(0);
  });
}

function parseFiniteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveTaskWithTimeoutBackoff(repoRoot, taskPool, candidateTask, baseReason) {
  if (!candidateTask || candidateTask.id !== "test_changed_closure") {
    return { task: candidateTask, reason: baseReason };
  }
  const closureReportPath = path.join(repoRoot, TEST_CHANGED_CLOSURE_REPORT_REL);
  const closureReport = await readJson(closureReportPath);
  const lastGeneratedAt = parseIsoTimestamp(closureReport?.generatedAt);
  const withinBackoff =
    lastGeneratedAt !== null &&
    Date.now() - lastGeneratedAt < TEST_CHANGED_CLOSURE_TIMEOUT_BACKOFF_MS;
  const transientClosureFailure =
    closureReport?.status === "failed" &&
    (closureReport?.failureKind === "timeout" || closureReport?.failureKind === "spawn_error");
  if (transientClosureFailure && withinBackoff) {
    return {
      task: pickNextTask(taskPool, candidateTask.id),
      reason: `${baseReason}; skip test_changed_closure due to recent timeout/spawn_error report`,
    };
  }
  return { task: candidateTask, reason: baseReason };
}

async function runCardFrameworkPreflight(repoRoot) {
  const startedAt = Date.now();
  try {
    const report = await collectCardFrameworkReport({
      repoRoot,
      simulationIterations: 1000,
    });
    const simulation = report.summary?.simulation ?? {};
    const ok =
      report.summary?.ok === true &&
      simulation.iterations === 1000 &&
      simulation.mismatches === 0 &&
      simulation.falseAccepted === 0 &&
      simulation.falseBlocked === 0;
    return {
      ok,
      command: CARD_FRAMEWORK_PREFLIGHT_COMMAND,
      durationMs: Date.now() - startedAt,
      errorCode: ok ? "OK" : "BLOCKED_CARD_FRAMEWORK",
      summary: {
        ok: report.summary?.ok === true,
        cards: report.summary?.cards ?? 0,
        totalChecks: report.summary?.total ?? 0,
        passedChecks: report.summary?.passed ?? 0,
        failedChecks: report.summary?.failed ?? 0,
        simulationIterations: simulation.iterations ?? 0,
        simulationCorrect: simulation.correct ?? 0,
        simulationMismatches: simulation.mismatches ?? 0,
        acceptedCorrect: simulation.acceptedCorrect ?? 0,
        blockedIncorrect: simulation.blockedIncorrect ?? 0,
        falseAccepted: simulation.falseAccepted ?? 0,
        falseBlocked: simulation.falseBlocked ?? 0,
      },
      coverage: {
        byType: report.coverage?.byType ?? {},
        byTarget: report.coverage?.byTarget ?? {},
        byComponentRole: report.coverage?.byComponentRole ?? {},
      },
      failedChecks: report.checks
        .filter((check) => check.status === "fail")
        .map((check) => ({
          id: check.id,
          label: check.label,
          message: check.message,
          cardId: check.cardId ?? null,
        })),
    };
  } catch (error) {
    return {
      ok: false,
      command: CARD_FRAMEWORK_PREFLIGHT_COMMAND,
      durationMs: Date.now() - startedAt,
      errorCode: "BLOCKED_CARD_FRAMEWORK",
      summary: {
        ok: false,
        cards: 0,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 1,
        simulationIterations: 0,
        simulationCorrect: 0,
        simulationMismatches: 1,
        acceptedCorrect: 0,
        blockedIncorrect: 0,
        falseAccepted: 1,
        falseBlocked: 0,
      },
      coverage: {
        byType: {},
        byTarget: {},
        byComponentRole: {},
      },
      failedChecks: [
        {
          id: "card-framework-preflight:runtime-error",
          label: "卡片框架 preflight",
          message: error instanceof Error ? error.message : String(error),
          cardId: null,
        },
      ],
    };
  }
}

function buildCardFrameworkBlockedCommandResult(cardFrameworkPreflight) {
  return {
    exitCode: 1,
    durationMs: cardFrameworkPreflight.durationMs,
    stdout: "",
    stderr: "BLOCKED_CARD_FRAMEWORK: card framework preflight failed before task execution",
    errorCode: "BLOCKED_CARD_FRAMEWORK",
  };
}

function buildCardFrameworkBlockedReportWorkflow(
  selectedTask,
  commandResult,
  cardFrameworkPreflight,
) {
  return {
    schema: "openclaw.controlled-task-runner.report-workflow.v1",
    generatedAt: new Date().toISOString(),
    steps: [
      {
        id: "card_framework_preflight",
        command: cardFrameworkPreflight.command,
        exitCode: 1,
        errorCode: cardFrameworkPreflight.errorCode,
        status: "fail",
        evidence: cardFrameworkPreflight.summary,
      },
      {
        id: "task_command_skipped",
        command: [selectedTask.command, ...selectedTask.args].join(" "),
        exitCode: commandResult.exitCode,
        errorCode: commandResult.errorCode,
        status: "fail",
      },
    ],
    consistency: "consistent",
    finalStatus: "fail",
  };
}

async function runTaskSemanticValidator(selectedTask) {
  if (selectedTask.id === "autonomous_inventory_check") {
    const validatorCommand = "collectAutonomousInventory(process.cwd())";
    const report = await collectAutonomousInventory(process.cwd());
    const summary = report?.summary ?? null;
    const ok = summary?.ok ?? false;
    return {
      id: "semantic_inventory_validator",
      command: validatorCommand,
      exitCode: ok ? 0 : 1,
      status: ok ? "pass" : "fail",
      evidence: {
        summaryOk: summary?.ok ?? null,
        summaryPassed: summary?.passed ?? null,
        summaryTotal: summary?.total ?? null,
        summaryFailed: summary?.failed ?? null,
      },
    };
  }

  if (selectedTask.id === "controlled_task_runner_check") {
    const validatorCommand = "in-process controlled task runner contract check";
    const runnerPath = path.join(process.cwd(), "scripts", "openclaw-controlled-task-runner.mjs");
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const runnerContent = await fs.readFile(runnerPath, "utf8");
    const packageJson = JSON.parse(
      (await fs.readFile(packageJsonPath, "utf8")).replace(/^\uFEFF/, ""),
    );
    const tokenChecks = {
      hasTelegramJsonToken: runnerContent.includes(
        "openclaw-controlled-task-runner-telegram-latest.json",
      ),
      hasTelegramMdToken: runnerContent.includes(
        "openclaw-controlled-task-runner-telegram-latest.md",
      ),
      hasPublishScriptToken: runnerContent.includes(
        "openclaw-controlled-task-runner-telegram-publish.mjs",
      ),
      hasClosureToken: runnerContent.includes("autonomous:test:changed:closure"),
      hasErrorCodeToken: runnerContent.includes("errorCode"),
      hasPaperOrderModeToken: runnerContent.includes("paperOrderMode"),
      hasOrderModeOneLineToken: runnerContent.includes("orderMode="),
      hasOrderModeZhTwToken: runnerContent.includes("下單模式="),
      hasCoreProductMatrixToken: runnerContent.includes("capital_core_product_freshness_matrix"),
      hasCoreMatrixOneLineToken: runnerContent.includes("coreMatrix="),
      hasCoreMatrixZhTwToken: runnerContent.includes("核心商品="),
      hasCapitalServiceStatusToken: runnerContent.includes("capital_service_status"),
      hasCapitalServiceStatusScriptToken: runnerContent.includes("capital:service-status"),
      hasCapitalQuoteStatusScript:
        typeof packageJson?.scripts?.["capital:quote:status"] === "string" &&
        packageJson.scripts["capital:quote:status"].includes(
          "scripts/openclaw-capital-quote-status.mjs --write-state --json",
        ),
      hasCapitalServiceStatusCheckToken: runnerContent.includes("capital_service_status_check"),
      hasCapitalServiceStatusCheckScriptToken: runnerContent.includes(
        "capital:service-status:check",
      ),
      hasStrategyFillSimulationTaskToken: runnerContent.includes("strategy_fill_simulation"),
      hasStrategyFillSimulationScriptToken: runnerContent.includes(
        "capital:strategy:fill-simulation",
      ),
      hasStrategyFillSimulationPackageScript:
        typeof packageJson?.scripts?.["capital:strategy:fill-simulation"] === "string" &&
        packageJson.scripts["capital:strategy:fill-simulation"].includes(
          "scripts/openclaw-capital-strategy-fill-simulator.mjs",
        ),
      hasStrategyFillSimulationCheckPackageScript:
        typeof packageJson?.scripts?.["capital:strategy:fill-simulation:check"] === "string" &&
        packageJson.scripts["capital:strategy:fill-simulation:check"].includes(
          "scripts/check-capital-strategy-fill-simulation.mjs",
        ),
      hasStrategyEquityPositionSizerCheckPackageScript:
        typeof packageJson?.scripts?.["capital:strategy:equity-position-sizer:check"] ===
          "string" &&
        packageJson.scripts["capital:strategy:equity-position-sizer:check"].includes(
          "scripts/check-capital-strategy-equity-position-sizer.mjs",
        ),
      hasStrategyEquityPositionSizerCheckHftPackageScript:
        typeof packageJson?.scripts?.["capital-hft:strategy:equity-position-sizer:check"] ===
          "string" &&
        packageJson.scripts["capital-hft:strategy:equity-position-sizer:check"].includes(
          "scripts/check-capital-strategy-equity-position-sizer.mjs",
        ),
      hasStrategyTailRiskRepairTaskToken: runnerContent.includes("strategy_tail_risk_repair"),
      hasStrategyTailRiskRepairScriptToken: runnerContent.includes(
        "capital:strategy:tail-risk-repair",
      ),
      hasStrategyTailRiskRepairPackageScript:
        typeof packageJson?.scripts?.["capital:strategy:tail-risk-repair"] === "string" &&
        packageJson.scripts["capital:strategy:tail-risk-repair"].includes(
          "scripts/openclaw-capital-strategy-tail-risk-repair.mjs --json",
        ),
      hasStrategyTailRiskRepairCheckPackageScript:
        typeof packageJson?.scripts?.["capital:strategy:tail-risk-repair:check"] === "string" &&
        packageJson.scripts["capital:strategy:tail-risk-repair:check"].includes(
          "scripts/check-capital-strategy-tail-risk-repair.mjs",
        ),
      hasDomesticQuoteComGuardRecoveryTaskToken: runnerContent.includes(
        "capital_domestic_quote_com_guard_recovery",
      ),
      hasDomesticQuoteComGuardBlockerToken: runnerContent.includes(
        "domestic_quote_com_rpc_failed_requires_restart",
      ),
      hasDomesticQuoteComGuardPathEnvToken: runnerContent.includes(
        "OPENCLAW_CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH",
      ),
      hasDomesticQuoteComGuardRecoveryScriptToken: runnerContent.includes(
        "scripts/openclaw-capital-domestic-quote-com-guard-recovery.mjs",
      ),
      hasFreshQuoteGateLatestPathToken: runnerContent.includes(
        "OPENCLAW_CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH",
      ),
      hasCardFrameworkImportToken: runnerContent.includes("collectCardFrameworkReport"),
      hasCardFrameworkPreflightCommandToken: runnerContent.includes(
        "CARD_FRAMEWORK_PREFLIGHT_COMMAND",
      ),
      hasCardFrameworkPreflightToken: runnerContent.includes("card_framework_preflight"),
      hasBlockedCardFrameworkToken: runnerContent.includes("BLOCKED_CARD_FRAMEWORK"),
      hasCardFrameworkSimulationToken: runnerContent.includes("simulationIterations: 1000"),
      hasNextSafeScript:
        typeof packageJson?.scripts?.["autonomous:controlled:next-safe"] === "string" &&
        packageJson.scripts["autonomous:controlled:next-safe"].includes(
          "scripts/openclaw-controlled-task-runner.mjs --next-safe",
        ),
      hasRunScript:
        typeof packageJson?.scripts?.["autonomous:controlled:run"] === "string" &&
        packageJson.scripts["autonomous:controlled:run"].includes(
          "scripts/openclaw-controlled-task-runner.mjs --run",
        ),
      hasRunnerCheckScript:
        typeof packageJson?.scripts?.["check:openclaw-controlled-task-runner"] === "string" &&
        packageJson.scripts["check:openclaw-controlled-task-runner"].includes(
          "scripts/check-openclaw-controlled-task-runner.mjs",
        ),
    };
    const ok = Object.values(tokenChecks).every(Boolean);
    return {
      id: "semantic_runner_contract_validator",
      command: validatorCommand,
      exitCode: ok ? 0 : 1,
      status: ok ? "pass" : "fail",
      evidence: {
        ...tokenChecks,
      },
    };
  }

  if (selectedTask.id === "test_changed_closure_contract_check") {
    const validatorCommand = "in-process test changed closure contract check";
    const tokenChecks = await buildTestChangedClosureContractChecks();
    const ok = Object.values(tokenChecks).every(Boolean);
    return {
      id: "semantic_test_changed_closure_contract_validator",
      command: validatorCommand,
      exitCode: ok ? 0 : 1,
      status: ok ? "pass" : "fail",
      evidence: {
        ...tokenChecks,
      },
    };
  }

  return null;
}

async function buildReportWorkflow(selectedTask, commandResult, postTaskSteps = []) {
  const steps = [
    {
      id: "task_command_exit",
      command: [selectedTask.command, ...selectedTask.args].join(" "),
      exitCode: commandResult.exitCode,
      errorCode: commandResult.errorCode ?? null,
      status: commandResult.exitCode === 0 ? "pass" : "fail",
    },
  ];
  const semanticStep = await runTaskSemanticValidator(selectedTask);
  if (semanticStep) {
    steps.push(semanticStep);
  }
  for (const step of postTaskSteps) {
    if (step) {
      steps.push(step);
    }
  }

  const commandStatus = commandResult.exitCode === 0 ? "pass" : "fail";
  const semanticStatus = semanticStep?.status ?? "unknown";
  const postTaskFailed = postTaskSteps.some((step) => step?.status === "fail");
  const inconsistent =
    semanticStep !== null &&
    ((commandStatus === "fail" && semanticStatus === "pass") ||
      (commandStatus === "pass" && semanticStatus === "fail"));
  const finalStatus = postTaskFailed
    ? "fail"
    : semanticStep?.status === "pass"
      ? "pass"
      : semanticStep?.status === "fail"
        ? "fail"
        : commandStatus;

  return {
    schema: "openclaw.controlled-task-runner.report-workflow.v1",
    generatedAt: new Date().toISOString(),
    steps,
    consistency: inconsistent ? "inconsistent" : "consistent",
    finalStatus,
  };
}

function shouldTryDirectFallback(commandResult) {
  return (
    commandResult.exitCode !== 0 &&
    typeof commandResult.errorCode === "string" &&
    EPERM_FALLBACK_ERROR_CODES.has(commandResult.errorCode)
  );
}

function resolveTaskDirectFallback(taskId) {
  return TASK_DIRECT_FALLBACKS[taskId] ?? null;
}

async function runInProcessFallback(selectedTask) {
  const startedAt = Date.now();
  if (selectedTask.id === "autonomous_inventory_check") {
    try {
      const report = await collectAutonomousInventory(process.cwd());
      const ok = report?.summary?.ok ?? false;
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok ? "autonomous inventory check passed\n" : "autonomous inventory check failed\n",
        stderr: "",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "controlled_task_runner_check") {
    try {
      const runnerPath = path.join(process.cwd(), "scripts", "openclaw-controlled-task-runner.mjs");
      const packageJsonPath = path.join(process.cwd(), "package.json");
      const runnerContent = await fs.readFile(runnerPath, "utf8");
      const packageJson = JSON.parse(
        (await fs.readFile(packageJsonPath, "utf8")).replace(/^\uFEFF/, ""),
      );
      const tokenChecks = [
        runnerContent.includes("openclaw-controlled-task-runner-telegram-latest.json"),
        runnerContent.includes("openclaw-controlled-task-runner-telegram-latest.md"),
        runnerContent.includes("openclaw-controlled-task-runner-telegram-publish.mjs"),
        runnerContent.includes("autonomous:test:changed:closure"),
        runnerContent.includes("errorCode"),
        runnerContent.includes("paperOrderMode"),
        runnerContent.includes("orderMode="),
        runnerContent.includes("下單模式="),
        runnerContent.includes("capital_core_product_freshness_matrix"),
        runnerContent.includes("coreMatrix="),
        runnerContent.includes("核心商品="),
        runnerContent.includes("capital_service_status"),
        runnerContent.includes("capital:service-status"),
        typeof packageJson?.scripts?.["capital:quote:status"] === "string" &&
          packageJson.scripts["capital:quote:status"].includes(
            "scripts/openclaw-capital-quote-status.mjs --write-state --json",
          ),
        runnerContent.includes("capital_service_status_check"),
        runnerContent.includes("capital:service-status:check"),
        runnerContent.includes("capital_domestic_quote_com_guard_recovery"),
        runnerContent.includes("domestic_quote_com_rpc_failed_requires_restart"),
        runnerContent.includes("OPENCLAW_CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH"),
        runnerContent.includes("scripts/openclaw-capital-domestic-quote-com-guard-recovery.mjs"),
        runnerContent.includes("OPENCLAW_CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH"),
        runnerContent.includes("collectCardFrameworkReport"),
        runnerContent.includes("CARD_FRAMEWORK_PREFLIGHT_COMMAND"),
        runnerContent.includes("card_framework_preflight"),
        runnerContent.includes("BLOCKED_CARD_FRAMEWORK"),
        runnerContent.includes("simulationIterations: 1000"),
        runnerContent.includes("recommended.target !== taskId"),
        runnerContent.includes("paper_hft_fill_simulation"),
        runnerContent.includes("capital:paper-hft:fill-simulation"),
        runnerContent.includes("paper_hft_strategy_evaluate"),
        runnerContent.includes("capital:paper-hft:evaluate"),
        runnerContent.includes("paper_hft_auto_review"),
        runnerContent.includes("capital:paper-hft:auto-review"),
        runnerContent.includes("paper_loop_error_repair"),
        runnerContent.includes("capital:paper-loop:error-repair"),
        runnerContent.includes("strategy_bar_accumulator"),
        runnerContent.includes("capital:strategy:bar-accumulator"),
        runnerContent.includes("strategy_engine"),
        runnerContent.includes("capital:strategy:engine"),
        runnerContent.includes("strategy_fill_simulation"),
        runnerContent.includes("capital:strategy:fill-simulation"),
        runnerContent.includes("strategy_tail_risk_repair"),
        runnerContent.includes("capital:strategy:tail-risk-repair"),
        typeof packageJson?.scripts?.["autonomous:controlled:next-safe"] === "string" &&
          packageJson.scripts["autonomous:controlled:next-safe"].includes(
            "scripts/openclaw-controlled-task-runner.mjs --next-safe",
          ),
        typeof packageJson?.scripts?.["autonomous:controlled:run"] === "string" &&
          packageJson.scripts["autonomous:controlled:run"].includes(
            "scripts/openclaw-controlled-task-runner.mjs --run",
          ),
        typeof packageJson?.scripts?.["check:openclaw-controlled-task-runner"] === "string" &&
          packageJson.scripts["check:openclaw-controlled-task-runner"].includes(
            "scripts/check-openclaw-controlled-task-runner.mjs",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:fill-simulation"] === "string" &&
          packageJson.scripts["capital:paper-hft:fill-simulation"].includes(
            "scripts/openclaw-capital-paper-fill-simulator.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:fill-simulation:check"] === "string" &&
          packageJson.scripts["capital:paper-hft:fill-simulation:check"].includes(
            "scripts/check-capital-paper-fill-simulator.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:paper-hft:fill-simulation"] === "string" &&
          packageJson.scripts["capital-hft:paper-hft:fill-simulation"].includes(
            "scripts/openclaw-capital-paper-fill-simulator.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:evaluate"] === "string" &&
          packageJson.scripts["capital:paper-hft:evaluate"].includes(
            "scripts/openclaw-capital-paper-strategy-evaluator.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:evaluate:check"] === "string" &&
          packageJson.scripts["capital:paper-hft:evaluate:check"].includes(
            "scripts/check-capital-paper-strategy-evaluator.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:paper-hft:evaluate"] === "string" &&
          packageJson.scripts["capital-hft:paper-hft:evaluate"].includes(
            "scripts/openclaw-capital-paper-strategy-evaluator.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:auto-review"] === "string" &&
          packageJson.scripts["capital:paper-hft:auto-review"].includes(
            "scripts/openclaw-capital-paper-auto-review.mjs --write-state --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-hft:auto-review:check"] === "string" &&
          packageJson.scripts["capital:paper-hft:auto-review:check"].includes(
            "scripts/check-capital-paper-auto-review.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:paper-hft:auto-review"] === "string" &&
          packageJson.scripts["capital-hft:paper-hft:auto-review"].includes(
            "scripts/openclaw-capital-paper-auto-review.mjs --write-state --json",
          ),
        typeof packageJson?.scripts?.["capital-hft:paper-hft:auto-review:check"] === "string" &&
          packageJson.scripts["capital-hft:paper-hft:auto-review:check"].includes(
            "scripts/check-capital-paper-auto-review.mjs",
          ),
        typeof packageJson?.scripts?.["capital:strategy:tail-risk-repair"] === "string" &&
          packageJson.scripts["capital:strategy:tail-risk-repair"].includes(
            "scripts/openclaw-capital-strategy-tail-risk-repair.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:strategy:tail-risk-repair:check"] === "string" &&
          packageJson.scripts["capital:strategy:tail-risk-repair:check"].includes(
            "scripts/check-capital-strategy-tail-risk-repair.mjs",
          ),
        typeof packageJson?.scripts?.["capital:paper-loop:error-repair"] === "string" &&
          packageJson.scripts["capital:paper-loop:error-repair"].includes(
            "scripts/openclaw-capital-paper-error-repair.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:paper-loop:error-repair:check"] === "string" &&
          packageJson.scripts["capital:paper-loop:error-repair:check"].includes(
            "scripts/check-capital-paper-error-repair.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:paper-loop:error-repair"] === "string" &&
          packageJson.scripts["capital-hft:paper-loop:error-repair"].includes(
            "scripts/openclaw-capital-paper-error-repair.mjs --json",
          ),
        typeof packageJson?.scripts?.["capital:strategy:bar-accumulator"] === "string" &&
          packageJson.scripts["capital:strategy:bar-accumulator"].includes(
            "scripts/openclaw-capital-bar-accumulator.mjs --symbol tx-front",
          ),
        typeof packageJson?.scripts?.["capital-hft:strategy:bar-accumulator"] === "string" &&
          packageJson.scripts["capital-hft:strategy:bar-accumulator"].includes(
            "scripts/openclaw-capital-bar-accumulator.mjs --symbol tx-front",
          ),
        typeof packageJson?.scripts?.["capital:strategy:engine"] === "string" &&
          packageJson.scripts["capital:strategy:engine"].includes(
            "scripts/openclaw-capital-strategy-engine.mjs --symbol tx-front",
          ),
        typeof packageJson?.scripts?.["capital:strategy:engine:check"] === "string" &&
          packageJson.scripts["capital:strategy:engine:check"].includes(
            "scripts/check-capital-strategy-engine.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:strategy:engine"] === "string" &&
          packageJson.scripts["capital-hft:strategy:engine"].includes(
            "scripts/openclaw-capital-strategy-engine.mjs --symbol tx-front",
          ),
        typeof packageJson?.scripts?.["capital:strategy:equity-position-sizer:check"] ===
          "string" &&
          packageJson.scripts["capital:strategy:equity-position-sizer:check"].includes(
            "scripts/check-capital-strategy-equity-position-sizer.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:strategy:equity-position-sizer:check"] ===
          "string" &&
          packageJson.scripts["capital-hft:strategy:equity-position-sizer:check"].includes(
            "scripts/check-capital-strategy-equity-position-sizer.mjs",
          ),
        typeof packageJson?.scripts?.["capital:strategy:fill-simulation"] === "string" &&
          packageJson.scripts["capital:strategy:fill-simulation"].includes(
            "scripts/openclaw-capital-strategy-fill-simulator.mjs",
          ),
        typeof packageJson?.scripts?.["capital:strategy:fill-simulation:check"] === "string" &&
          packageJson.scripts["capital:strategy:fill-simulation:check"].includes(
            "scripts/check-capital-strategy-fill-simulation.mjs",
          ),
        typeof packageJson?.scripts?.["capital-hft:strategy:fill-simulation"] === "string" &&
          packageJson.scripts["capital-hft:strategy:fill-simulation"].includes(
            "scripts/openclaw-capital-strategy-fill-simulator.mjs",
          ),
      ];
      const ok = tokenChecks.every(Boolean);
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok
          ? "OPENCLAW_CONTROLLED_TASK_RUNNER_CHECK=OK\n"
          : "OPENCLAW_CONTROLLED_TASK_RUNNER_CHECK=FAIL\n",
        stderr: "",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "test_changed_closure_contract_check") {
    try {
      const tokenChecks = await buildTestChangedClosureContractChecks();
      const ok = Object.values(tokenChecks).every(Boolean);
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok
          ? "OPENCLAW_TEST_CHANGED_CLOSURE_CHECK=OK\n"
          : "OPENCLAW_TEST_CHANGED_CLOSURE_CHECK=FAIL\n",
        stderr: "",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_quote_status_check") {
    try {
      const moduleHref = pathToFileURL(
        path.join(process.cwd(), "scripts", "check-capital-quote-status.mjs"),
      ).href;
      const priorExitCode = process.exitCode;
      process.exitCode = 0;
      await import(`${moduleHref}?run=${Date.now()}`);
      const postExitCode = process.exitCode ?? 0;
      process.exitCode = priorExitCode ?? 0;
      const ok = postExitCode === 0;
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok ? "CAPITAL_QUOTE_STATUS_CHECK=OK\n" : "",
        stderr: ok ? "" : "check-capital-quote-status failed via process.exitCode",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_service_status_check") {
    try {
      const moduleHref = pathToFileURL(
        path.join(process.cwd(), "scripts", "check-capital-service-status.mjs"),
      ).href;
      const priorExitCode = process.exitCode;
      process.exitCode = 0;
      await import(`${moduleHref}?run=${Date.now()}`);
      const postExitCode = process.exitCode ?? 0;
      process.exitCode = priorExitCode ?? 0;
      const ok = postExitCode === 0;
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok ? "CAPITAL_SERVICE_STATUS_CHECK=OK\n" : "",
        stderr: ok ? "" : "check-capital-service-status failed via process.exitCode",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_domestic_quote_com_guard_recovery") {
    try {
      const moduleHref = pathToFileURL(
        path.join(
          process.cwd(),
          "scripts",
          "openclaw-capital-domestic-quote-com-guard-recovery.mjs",
        ),
      ).href;
      const module = await import(`${moduleHref}?run=${Date.now()}`);
      const report = await module.buildCapitalDomesticQuoteComGuardRecovery({
        repoRoot: process.cwd(),
        writeState: true,
        simulateRuns: 500,
        executeIfSafe: true,
      });
      const ok =
        report?.simulation?.failedCases === 0 &&
        report?.safety?.sentOrder === false &&
        report?.safety?.writeBrokerOrders === false &&
        report?.safety?.brokerWriteAttempted === false &&
        report?.status !== "blocked_path_safety" &&
        report?.status !== "guard_present_recovery_missing";
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok
          ? "CAPITAL_DOMESTIC_QUOTE_COM_GUARD_RECOVERY=OK\n"
          : "CAPITAL_DOMESTIC_QUOTE_COM_GUARD_RECOVERY=FAIL\n",
        stderr: ok ? "" : `guard recovery status=${report?.status ?? "unknown"}`,
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_overseas_stale_recovery") {
    try {
      const moduleHref = pathToFileURL(
        path.join(process.cwd(), "scripts", "openclaw-capital-overseas-stale-recovery.mjs"),
      ).href;
      const module = await import(`${moduleHref}?run=${Date.now()}`);
      const report = await module.buildCapitalOverseasStaleRecovery({
        repoRoot: process.cwd(),
        simulateRuns: 500,
        executeIfSafe: true,
      });
      await module.writeCapitalOverseasStaleRecovery(report, process.cwd());
      const ok =
        report?.simulation?.failedCases === 0 &&
        report?.safety?.sentOrder === false &&
        report?.safety?.writeBrokerOrders === false &&
        report?.safety?.brokerWriteAttempted === false &&
        ["ready_no_recovery_needed", "recovery_executed_ready"].includes(report?.status);
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok
          ? "CAPITAL_OVERSEAS_STALE_RECOVERY=OK\n"
          : "CAPITAL_OVERSEAS_STALE_RECOVERY=FAIL\n",
        stderr: ok ? "" : `overseas stale recovery status=${report?.status ?? "unknown"}`,
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_telegram_owner_check") {
    try {
      const moduleHref = pathToFileURL(
        path.join(process.cwd(), "scripts", "openclaw-capital-telegram-owner-check.mjs"),
      ).href;
      const module = await import(`${moduleHref}?run=${Date.now()}`);
      const report = await module.readCapitalTelegramOwnerCheck({ repoRoot: process.cwd() });
      await module.writeCapitalTelegramOwnerCheck(report, { repoRoot: process.cwd() });
      const ok = report.ready === true;
      return {
        exitCode: ok ? 0 : 2,
        durationMs: Date.now() - startedAt,
        stdout: `${report.replyLine ?? ""}\n`,
        stderr: ok ? "" : report.blockerCode || report.status || "telegram owner check blocked",
        errorCode: ok ? "OK" : report.blockerCode || "TELEGRAM_OWNER_BLOCKED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  if (selectedTask.id === "capital_telegram_owner_contract_check") {
    try {
      const moduleHref = pathToFileURL(
        path.join(process.cwd(), "scripts", "check-capital-telegram-owner-check.mjs"),
      ).href;
      const priorExitCode = process.exitCode;
      process.exitCode = 0;
      await import(`${moduleHref}?run=${Date.now()}`);
      const postExitCode = process.exitCode ?? 0;
      process.exitCode = priorExitCode ?? 0;
      const ok = postExitCode === 0;
      return {
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
        stdout: ok ? "CAPITAL_TELEGRAM_OWNER_CHECK=OK\n" : "",
        stderr: ok ? "" : "check-capital-telegram-owner-check failed via process.exitCode",
        errorCode: ok ? "OK" : "IN_PROCESS_VALIDATION_FAILED",
      };
    } catch (error) {
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        errorCode: "IN_PROCESS_RUNTIME_ERROR",
      };
    }
  }

  return {
    exitCode: 1,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: `unsupported in-process fallback task: ${selectedTask.id}`,
    errorCode: "IN_PROCESS_UNSUPPORTED_TASK",
  };
}

async function runTaskCommandWithFallback(selectedTask) {
  const primaryResult = await runCommand(selectedTask.command, selectedTask.args);
  const fallbackSpec = resolveTaskDirectFallback(selectedTask.id);
  if (!fallbackSpec || !shouldTryDirectFallback(primaryResult)) {
    return {
      commandResult: primaryResult,
      fallback: null,
    };
  }

  const fallbackResult =
    fallbackSpec.mode === "in_process"
      ? await runInProcessFallback(selectedTask)
      : await runCommand(fallbackSpec.command, fallbackSpec.args);
  const fallback = {
    attempted: true,
    command:
      fallbackSpec.mode === "in_process"
        ? `in_process:${selectedTask.id}`
        : [fallbackSpec.command, ...fallbackSpec.args].join(" "),
    mode: fallbackSpec.mode ?? "spawn",
    exitCode: fallbackResult.exitCode,
    errorCode: fallbackResult.errorCode ?? null,
    durationMs: fallbackResult.durationMs,
    promoted: fallbackResult.exitCode === 0,
  };

  return {
    commandResult: fallback.promoted ? fallbackResult : primaryResult,
    fallback,
  };
}

function normalizeTelegramTarget(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function pickLatestTelegramTarget(history) {
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    return "";
  }
  let bestTarget = "";
  let bestTimestamp = -1;
  for (const [target, payload] of Object.entries(history)) {
    const normalizedTarget = normalizeTelegramTarget(target);
    if (!normalizedTarget) {
      continue;
    }
    let candidateTimestamp = -1;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const value of Object.values(payload)) {
        const parsed = parseFiniteTimestamp(value);
        if (parsed !== null && parsed > candidateTimestamp) {
          candidateTimestamp = parsed;
        }
      }
    }
    if (candidateTimestamp > bestTimestamp) {
      bestTimestamp = candidateTimestamp;
      bestTarget = normalizedTarget;
    }
  }
  return bestTarget;
}

async function resolveTelegramPublishTarget(repoRoot) {
  const envTarget = normalizeTelegramTarget(process.env[TELEGRAM_PUBLISH_TARGET_ENV] ?? "");
  if (envTarget) {
    return {
      target: envTarget,
      source: "env",
      sourcePath: null,
    };
  }
  const sentMessagesPath = path.join(repoRoot, TELEGRAM_SENT_MESSAGES_REL);
  const history = await readJson(sentMessagesPath);
  const historyTarget = pickLatestTelegramTarget(history);
  if (!historyTarget) {
    return {
      target: "",
      source: "missing",
      sourcePath: toPosix(path.relative(repoRoot, sentMessagesPath)),
    };
  }
  return {
    target: historyTarget,
    source: "sent_messages_history",
    sourcePath: toPosix(path.relative(repoRoot, sentMessagesPath)),
  };
}

function formatNextSafe(
  task,
  reason,
  readOnlyMode,
  cardId = null,
  resolverCandidate = null,
  dmadPublishStatus = null,
) {
  const dmadValidationHint = buildDmadValidationHint();
  const resolvedDmadPublishStatus = dmadPublishStatus ?? buildDmadPublishStatus(null);
  const machineLine = [
    `nextSafe=${task.id}`,
    dmadValidationHint.machineLine,
    resolvedDmadPublishStatus.machineLine,
    `readOnly=${String(readOnlyMode)}`,
  ].join(";");
  return {
    schema: "openclaw.controlled-task-runner.next-safe.v1",
    generatedAt: new Date().toISOString(),
    task: {
      id: task.id,
      label: task.label,
      command: [task.command, ...task.args].join(" "),
      cardId,
      resolverCandidateId: resolverCandidate?.id ?? null,
    },
    resolver_candidate: resolverCandidate,
    dmad_validation_hint: dmadValidationHint,
    dmad_publish_status: resolvedDmadPublishStatus,
    machineLine,
    readOnlyMode,
    reason,
  };
}

function buildDmadValidationHint() {
  return {
    command: DMAD_TIMEOUT_SMOKE_GATE_COMMAND,
    gate: DMAD_TIMEOUT_SMOKE_GATE_ID,
    source: DMAD_TIMEOUT_SMOKE_GATE_SOURCE,
    readOnlyMode: true,
    machineLine: `dmadGate=${DMAD_TIMEOUT_SMOKE_GATE_ID}`,
  };
}

function extractSchedulerNextRunAt(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return null;
  }
  return normalizeTextValue(text.match(/\bschedulerNextRunAt=([^\s｜|;]+)/u)?.[1]) ?? null;
}

function buildDmadPublishStatus(telegramPublish) {
  const status = normalizeTextValue(telegramPublish?.status) ?? "missing";
  const upstreamDmadGateCount = numericOrNull(telegramPublish?.upstreamDmadGateCount);
  const upstreamDmadGateVerified = telegramPublish?.upstreamDmadGateVerified === true;
  const upstreamOkxContractCount = numericOrNull(telegramPublish?.upstreamOkxContractCount);
  const upstreamOkxContractVerified = telegramPublish?.upstreamOkxContractVerified === true;
  const upstreamSchedulerNextRunAt =
    normalizeTextValue(telegramPublish?.upstreamSchedulerNextRunAt) ??
    extractSchedulerNextRunAt(telegramPublish?.reason) ??
    extractSchedulerNextRunAt(telegramPublish?.machineLine);
  const upstreamMessageTokenCountsSummaryZhTw =
    typeof telegramPublish?.upstreamMessageTokenCountsSummaryZhTw === "string"
      ? telegramPublish.upstreamMessageTokenCountsSummaryZhTw
      : null;
  const upstreamSummaryHasDmad = upstreamMessageTokenCountsSummaryZhTw?.includes("DMAD=1") === true;
  const upstreamSummaryHasOkxContract =
    upstreamMessageTokenCountsSummaryZhTw?.includes("OKX合約=1") === true;
  const upstreamSchedulerNextRunAtVisible = upstreamSchedulerNextRunAt !== null;
  const verified =
    upstreamDmadGateCount === 1 &&
    upstreamDmadGateVerified &&
    upstreamSummaryHasDmad &&
    upstreamOkxContractCount === 1 &&
    upstreamOkxContractVerified &&
    upstreamSummaryHasOkxContract &&
    upstreamSchedulerNextRunAtVisible;

  return {
    status,
    verified,
    upstreamDmadGateCount,
    upstreamDmadGateVerified,
    upstreamSummaryHasDmad,
    upstreamOkxContractCount,
    upstreamOkxContractVerified,
    upstreamSummaryHasOkxContract,
    upstreamSchedulerNextRunAt,
    upstreamSchedulerNextRunAtVisible,
    reportPath:
      normalizeTextValue(telegramPublish?.reportPath) ??
      `${STATE_DIR_REL}/${TELEGRAM_PUBLISH_BRIDGE_REPORT_NAME}`,
    machineLine: `dmadPublish=${verified ? "verified" : "blocked"};status=${status};dmadGate=${String(upstreamDmadGateCount ?? "unknown")};summaryDmad=${String(upstreamSummaryHasDmad)};okxContract=${String(upstreamOkxContractCount ?? "unknown")};summaryOkxContract=${String(upstreamSummaryHasOkxContract)};schedulerNextRunAt=${upstreamSchedulerNextRunAt ?? "unknown"}`,
  };
}

async function readLatestDmadPublishStatus(repoRoot) {
  const latestReport = await readJson(path.join(repoRoot, STATE_DIR_REL, LATEST_REPORT_NAME));
  if (
    latestReport?.dmad_publish_status &&
    typeof latestReport.dmad_publish_status === "object" &&
    !Array.isArray(latestReport.dmad_publish_status)
  ) {
    if (
      latestReport.dmad_publish_status.upstreamOkxContractCount !== undefined &&
      latestReport.dmad_publish_status.upstreamSchedulerNextRunAt !== undefined
    ) {
      return latestReport.dmad_publish_status;
    }
    if (
      latestReport?.validation_result?.telegram_publish &&
      typeof latestReport.validation_result.telegram_publish === "object" &&
      !Array.isArray(latestReport.validation_result.telegram_publish)
    ) {
      return buildDmadPublishStatus(latestReport.validation_result.telegram_publish);
    }
    return latestReport.dmad_publish_status;
  }

  if (
    latestReport?.validation_result?.telegram_publish &&
    typeof latestReport.validation_result.telegram_publish === "object" &&
    !Array.isArray(latestReport.validation_result.telegram_publish)
  ) {
    return buildDmadPublishStatus(latestReport.validation_result.telegram_publish);
  }

  const bridgeReport = await readJson(
    path.join(repoRoot, STATE_DIR_REL, TELEGRAM_PUBLISH_BRIDGE_REPORT_NAME),
  );
  return buildDmadPublishStatus(bridgeReport);
}

function deriveQuoteBlockers(quoteStatus) {
  if (!quoteStatus || typeof quoteStatus !== "object") {
    return [];
  }
  const blockers = [];
  if (quoteStatus?.status === "stale" || quoteStatus?.quoteProof?.freshnessStatus === "stale") {
    blockers.push("quote_freshness_stale");
  }
  if (quoteStatus?.session?.tradingOpen === false) {
    blockers.push("market_session_closed");
  }
  return blockers;
}

function summarizeCapitalServiceStatus(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      exists: false,
      ready: false,
      status: "missing",
      quoteReady: false,
      quoteStatus: "missing",
      liveOrderReady: false,
      liveOrderBlocker: "",
      staleQuoteReturned: false,
      strictGateSource: "",
      riskControlsObservedLive: false,
      riskControlsObservedWrite: false,
      replyLine: "",
    };
  }
  const riskControlsObserved = payload.riskControlsObserved ?? {};
  return {
    exists: true,
    ready: payload.ready === true,
    status: payload.status ?? "unknown",
    quoteReady: payload.quote?.ready === true,
    quoteStatus: payload.quote?.status ?? "unknown",
    liveOrderReady: payload.liveOrders?.ready === true,
    liveOrderBlocker: payload.liveOrders?.blocker ?? payload.liveOrders?.reason ?? "",
    staleQuoteReturned: payload.safety?.staleQuoteReturned === true,
    strictGateSource: payload.quote?.strictGateSource ?? "",
    riskControlsObservedLive: riskControlsObserved.allowLiveTrading === true,
    riskControlsObservedWrite: riskControlsObserved.writeBrokerOrders === true,
    matrixSummary: payload.quote?.matrixSummary ?? null,
    replyLine: payload.replyLine ?? "",
  };
}

function deriveCapitalServiceStatusBlockers(summary) {
  if (!summary.exists) {
    return ["capital_service_status_missing"];
  }
  if (summary.ready) {
    return [];
  }
  const blockers = [];
  if (!summary.quoteReady) {
    blockers.push(`capital_service_quote_blocked:${summary.quoteStatus || "unknown"}`);
  }
  if (summary.staleQuoteReturned) {
    blockers.push("capital_service_stale_quote_returned");
  }
  if (summary.riskControlsObservedLive || summary.riskControlsObservedWrite) {
    blockers.push("capital_risk_controls_live_write_observed");
  }
  if (blockers.length === 0) {
    blockers.push("capital_service_status_blocked");
  }
  return blockers;
}

async function loadRunnerState(repoRoot) {
  const statePath = path.join(repoRoot, RUNNER_STATE_REL);
  const state = await readJson(statePath);
  if (!state || typeof state !== "object") {
    return {
      path: statePath,
      payload: null,
    };
  }
  return {
    path: statePath,
    payload: state,
  };
}

function capitalQuickQuoteLatestPath() {
  const configured = (process.env[CAPITAL_QUICK_QUOTE_LATEST_PATH_ENV] ?? "").trim();
  return configured.length > 0 ? configured : CAPITAL_QUICK_QUOTE_LATEST_DEFAULT;
}

function capitalDomesticQuoteComGuardPath() {
  const configured = (process.env[CAPITAL_DOMESTIC_QUOTE_COM_GUARD_PATH_ENV] ?? "").trim();
  return configured.length > 0 ? configured : CAPITAL_DOMESTIC_QUOTE_COM_GUARD_DEFAULT;
}

function capitalFreshQuoteGateLatestPath() {
  const configured = (process.env[CAPITAL_FRESH_QUOTE_GATE_LATEST_PATH_ENV] ?? "").trim();
  return configured.length > 0 ? configured : CAPITAL_FRESH_QUOTE_GATE_LATEST_DEFAULT;
}

async function loadCapitalQuickQuoteLatest() {
  const latestPath = capitalQuickQuoteLatestPath();
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalDomesticQuoteComGuard() {
  const latestPath = capitalDomesticQuoteComGuardPath();
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalFreshQuoteGateLatest() {
  const latestPath = capitalFreshQuoteGateLatestPath();
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalFreshQuoteGateLatest(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? capitalFreshQuoteGateLatestPath(),
    ready: payload?.ready === true,
    status: payload?.status ?? "missing",
    blockerCode: payload?.blockerCode ?? "",
    generatedAt: payload?.generatedAt ?? "",
    requiredSymbols: Array.isArray(payload?.requiredSymbols) ? payload.requiredSymbols : [],
    callbackSummary: payload?.callback?.summary ?? null,
  };
}

function summarizeCapitalDomesticQuoteComGuard(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? capitalDomesticQuoteComGuardPath(),
    status: payload?.status ?? "missing",
    blockerCode: payload?.blockerCode ?? "",
    source: payload?.source ?? "",
    stock: payload?.stock ?? "",
    processId: payload?.processId ?? null,
    generatedAt: payload?.generatedAt ?? "",
    restartRequired:
      payload?.status === "restart_required" &&
      payload?.blockerCode === CAPITAL_DOMESTIC_QUOTE_COM_GUARD_BLOCKER,
    sentOrder: payload?.sentOrder === true,
    writeBrokerOrders: payload?.writeBrokerOrders === true,
  };
}

async function loadCapitalOverseasStaleRecovery(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_OVERSEAS_STALE_RECOVERY_REPORT_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalOverseasStaleRecovery(latest) {
  const payload = latest?.payload ?? {};
  const targetSummary = payload?.targetSummary ?? {};
  const recovery = payload?.recovery ?? {};
  const safety = payload?.safety ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    generatedAt: payload?.generatedAt ?? "",
    status: payload?.status ?? "missing",
    ready: payload?.ready === true,
    blockerCode: payload?.blockerCode ?? "",
    failedSteps: Array.isArray(payload?.failedSteps) ? payload.failedSteps : [],
    staleTargets: Array.isArray(targetSummary?.staleTargets) ? targetSummary.staleTargets : [],
    readyTargets: Array.isArray(targetSummary?.readyTargets) ? targetSummary.readyTargets : [],
    recoveryAllowed: recovery?.allowed === true,
    sentOrder: payload?.sentOrder === true || safety?.sentOrder === true,
    writeBrokerOrders: payload?.writeTradingEnabled === true || safety?.writeBrokerOrders === true,
    brokerWriteAttempted: safety?.brokerWriteAttempted === true,
  };
}

function deriveCapitalOverseasStaleRecoveryBlockers(summary, serviceStatusSummary) {
  if (serviceStatusSummary?.ready === true) {
    return [];
  }
  const blockedRequiredIds = Array.isArray(serviceStatusSummary?.matrixSummary?.blockedRequiredIds)
    ? serviceStatusSummary.matrixSummary.blockedRequiredIds
    : [];
  const hasOverseasBlockedRequired = blockedRequiredIds.some((id) =>
    CAPITAL_OVERSEAS_STALE_TARGET_PRODUCT_IDS.has(id),
  );
  if (summary?.recoveryAllowed || summary?.staleTargets?.length > 0 || hasOverseasBlockedRequired) {
    return ["capital_overseas_stale_recovery_ready"];
  }
  return [];
}

function deriveCapitalDomesticQuoteComGuardBlockers(summary, freshQuoteGate = null) {
  if (!summary.exists || !summary.restartRequired) {
    return [];
  }
  if (freshQuoteGate?.ready === true) {
    return [];
  }
  return [summary.blockerCode || CAPITAL_DOMESTIC_QUOTE_COM_GUARD_BLOCKER];
}

function reconcileCapitalDomesticQuoteComGuard(
  summary,
  { freshQuoteGate = null, serviceStatus = null } = {},
) {
  const serviceReady =
    serviceStatus?.ready === true &&
    serviceStatus?.quoteReady === true &&
    serviceStatus?.quoteStatus === "fresh" &&
    serviceStatus?.staleQuoteReturned !== true;
  const freshQuoteReady = freshQuoteGate?.ready === true;
  if (!summary?.restartRequired || (!freshQuoteReady && !serviceReady)) {
    return summary;
  }
  return {
    ...summary,
    status: "ok_superseded_by_fresh_quote",
    blockerCode: "",
    restartRequired: false,
    rawStatus: summary.status,
    rawBlockerCode: summary.blockerCode,
    supersededByFreshQuote: true,
    supersededBy: freshQuoteReady ? "fresh_quote_gate_ready" : "service_status_ready",
  };
}

function prioritizeTask(taskPool, taskId) {
  const task = taskPool.find((entry) => entry.id === taskId);
  if (!task) {
    return taskPool;
  }
  return [task, ...taskPool.filter((entry) => entry.id !== taskId)];
}

function summarizeCapitalQuickQuoteLatest(latest) {
  const payload = latest?.payload;
  const result = payload?.result ?? {};
  const readback = result.callbackReadback ?? {};
  const selected = readback.selectedItem ?? null;
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? capitalQuickQuoteLatestPath(),
    status: payload?.status ?? result.status ?? "missing",
    reportable: payload?.reportable === true || result.status === "matched",
    symbol: payload?.request?.symbol ?? result.requestedSymbol ?? result.symbol ?? null,
    canonicalSymbol: result.canonicalSymbol ?? result.symbol ?? selected?.canonicalSymbol ?? null,
    reason: result.reason ?? null,
    blockerCode: result.blockReason?.code ?? readback.blockerCode ?? null,
    callbackStatus: readback.status ?? null,
    callbackReportableCount:
      typeof readback.reportableCount === "number" ? readback.reportableCount : null,
    callbackFreshMatchedCount:
      typeof readback.freshMatchedCount === "number" ? readback.freshMatchedCount : null,
    callbackStaleOrMissingCount:
      typeof readback.staleOrMissingCount === "number" ? readback.staleOrMissingCount : null,
    selectedReason: selected?.reason ?? null,
    selectedMatched: typeof selected?.matched === "boolean" ? selected.matched : null,
    selectedFreshMatched:
      typeof selected?.freshMatched === "boolean" ? selected.freshMatched : null,
    selectedAgeMs: typeof selected?.ageMs === "number" ? selected.ageMs : null,
    missingSymbols: Array.isArray(readback.missingSymbols) ? readback.missingSymbols : [],
    staleSymbols: Array.isArray(readback.staleSymbols) ? readback.staleSymbols : [],
    generatedAt: payload?.generatedAt ?? readback.generatedAt ?? null,
  };
}

function reconcileCapitalQuickQuoteLatest(
  summary,
  { serviceStatus = null, freshQuoteGate = null } = {},
) {
  const freshQuoteReady = freshQuoteGate?.ready === true;
  const serviceReady = isCapitalQuoteStatusAuthoritativeReady(serviceStatus);
  if ((!freshQuoteReady && !serviceReady) || summary?.reportable === true) {
    return summary;
  }
  const coveredBy = freshQuoteReady ? "capital_fresh_quote_gate" : "capital_service_status";
  return {
    ...summary,
    status: freshQuoteReady ? "covered_by_fresh_quote_gate" : "covered_by_service_status",
    reportable: true,
    blockerCode: "",
    rawStatus: summary.status,
    rawReason: summary.reason,
    rawBlockerCode: summary.blockerCode,
    coveredByServiceStatus: serviceReady,
    coveredByFreshQuoteGate: freshQuoteReady,
    coveredBy,
  };
}

async function loadCapitalPaperAssistantState(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_PAPER_ASSISTANT_STATE_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadBlackboxAutonomyReport(repoRoot) {
  const latestPath = path.join(repoRoot, BLACKBOX_AUTONOMY_REPORT_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadBlackboxSyncReport(repoRoot) {
  const latestPath = path.join(repoRoot, BLACKBOX_SYNC_REPORT_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalPaperFillSimulation(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_PAPER_FILL_SIMULATION_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalPaperStrategyEvaluation(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_PAPER_STRATEGY_EVALUATION_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalPaperAutoReview(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_PAPER_AUTO_REVIEW_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalPaperErrorRepair(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_PAPER_ERROR_REPAIR_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadCapitalStrategyFillSimulation(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_STRATEGY_FILL_SIMULATION_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

async function loadHermesNuwaBridgeReport(repoRoot) {
  const latestPath = path.join(repoRoot, HERMES_NUWA_BRIDGE_REPORT_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalPaperFillSimulation(latest) {
  const payload = latest?.payload ?? {};
  const stats = payload?.stats ?? payload?.summary ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    readOnly: payload?.readOnly === true,
    liveTradingEnabled: payload?.liveTradingEnabled === true,
    writeTradingEnabled: payload?.writeTradingEnabled === true,
    brokerOrderPathEnabled: payload?.brokerOrderPathEnabled === true,
    strategyName: payload?.strategyName ?? "",
    totalIntents:
      typeof stats?.total_intents === "number"
        ? stats.total_intents
        : Number.isFinite(Number(stats?.totalIntents))
          ? Number(stats.totalIntents)
          : 0,
    fillRate:
      typeof stats?.fill_rate === "number"
        ? stats.fill_rate
        : Number.isFinite(Number(stats?.fillRate))
          ? Number(stats.fillRate)
          : null,
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeCapitalPaperStrategyEvaluation(latest) {
  const payload = latest?.payload ?? {};
  const summary = payload?.summary ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    readOnly: payload?.readOnly === true,
    liveTradingEnabled: payload?.liveTradingEnabled === true,
    writeTradingEnabled: payload?.writeTradingEnabled === true,
    brokerOrderPathEnabled: payload?.brokerOrderPathEnabled === true,
    recommendation: payload?.recommendation ?? "",
    passCount:
      typeof payload?.passCount === "number"
        ? payload.passCount
        : Number.isFinite(Number(payload?.passCount))
          ? Number(payload.passCount)
          : 0,
    ruleCount:
      typeof payload?.ruleCount === "number"
        ? payload.ruleCount
        : Number.isFinite(Number(payload?.ruleCount))
          ? Number(payload.ruleCount)
          : 0,
    fillRate:
      typeof summary?.fill_rate === "number"
        ? summary.fill_rate
        : Number.isFinite(Number(summary?.fillRate))
          ? Number(summary.fillRate)
          : null,
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeCapitalPaperAutoReview(latest) {
  const payload = latest?.payload ?? {};
  const summary = payload?.summary ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    promoted: payload?.promoted === true,
    currentEvaluationApproved: payload?.currentEvaluationApproved === true,
    readOnly: payload?.readOnly === true,
    liveTradingEnabled: payload?.liveTradingEnabled === true,
    writeTradingEnabled: payload?.writeTradingEnabled === true,
    brokerOrderPathEnabled: payload?.brokerOrderPathEnabled === true,
    passCount:
      typeof payload?.evaluationRef?.passCount === "number"
        ? payload.evaluationRef.passCount
        : Number.isFinite(Number(payload?.passCount))
          ? Number(payload.passCount)
          : 0,
    ruleCount:
      typeof payload?.evaluationRef?.ruleCount === "number"
        ? payload.evaluationRef.ruleCount
        : Number.isFinite(Number(payload?.ruleCount))
          ? Number(payload.ruleCount)
          : 0,
    recommendation: payload?.evaluationRef?.recommendation ?? "",
    fillRate:
      typeof summary?.fill_rate === "number"
        ? summary.fill_rate
        : Number.isFinite(Number(summary?.fillRate))
          ? Number(summary.fillRate)
          : null,
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeCapitalStrategyFillSimulation(latest) {
  const payload = latest?.payload ?? {};
  const stats = payload?.stats ?? {};
  const safetyLock = payload?.safetyLock ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    recommendation: payload?.recommendation ?? "",
    liveTradingEnabled:
      payload?.liveTradingEnabled === true || safetyLock?.liveTradingEnabled === true,
    writeTradingEnabled:
      payload?.writeTradingEnabled === true || safetyLock?.writeTradingEnabled === true,
    brokerOrderPathEnabled:
      payload?.brokerOrderPathEnabled === true || safetyLock?.brokerOrderPathEnabled === true,
    executionEligible: safetyLock?.executionEligible === true,
    promotionBlocked: safetyLock?.promotionBlocked === true,
    totalIntents:
      typeof stats?.total_intents === "number"
        ? stats.total_intents
        : Number.isFinite(Number(stats?.totalIntents))
          ? Number(stats.totalIntents)
          : 0,
    fillRate:
      typeof stats?.fill_rate === "number"
        ? stats.fill_rate
        : Number.isFinite(Number(stats?.fillRate))
          ? Number(stats.fillRate)
          : null,
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeHermesNuwaBridgeReport(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    sourceRecords:
      typeof payload?.sourceRecords === "number"
        ? payload.sourceRecords
        : Number.isFinite(Number(payload?.sourceRecords))
          ? Number(payload.sourceRecords)
          : 0,
    newPatternsInserted:
      typeof payload?.newPatternsInserted === "number"
        ? payload.newPatternsInserted
        : Number.isFinite(Number(payload?.newPatternsInserted))
          ? Number(payload.newPatternsInserted)
          : 0,
    updatedPatterns:
      typeof payload?.updatedPatterns === "number"
        ? payload.updatedPatterns
        : Number.isFinite(Number(payload?.updatedPatterns))
          ? Number(payload.updatedPatterns)
          : 0,
    skippedPatterns:
      typeof payload?.skippedPatterns === "number"
        ? payload.skippedPatterns
        : Number.isFinite(Number(payload?.skippedPatterns))
          ? Number(payload.skippedPatterns)
          : 0,
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeCapitalPaperErrorRepair(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    loopStatus: payload?.loopStatus ?? "missing",
    errorType: payload?.errorType ?? "unknown",
    repairStatus: payload?.repairStatus ?? "missing",
    repairAction: payload?.repairAction ?? "none",
    readOnly: payload?.readOnly === true,
    liveTradingEnabled: payload?.liveTradingEnabled === true,
    writeTradingEnabled: payload?.writeTradingEnabled === true,
    brokerOrderPathEnabled: payload?.brokerOrderPathEnabled === true,
    promotionBlocked: payload?.promotionBlocked === true,
    currentEvaluationApproved: payload?.currentEvaluationApproved === true,
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeCapitalPaperAssistantState(latest) {
  const liveOrderGate = latest?.payload?.liveOrderGate ?? {};
  const paperOrderMode = latest?.payload?.paperOrderMode ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: latest?.payload?.status ?? "missing",
    paperOrderMode: {
      status: paperOrderMode?.status ?? "unknown",
      pass: paperOrderMode?.pass === true,
      sentOrder: paperOrderMode?.sentOrder === true,
      liveOrdersEnabledByThisCheck: paperOrderMode?.liveOrdersEnabledByThisCheck === true,
      domesticReady: paperOrderMode?.domesticReady === true,
      overseasReady: paperOrderMode?.overseasReady === true,
      dayTradeReady: paperOrderMode?.dayTradeReady === true,
      overnightReady: paperOrderMode?.overnightReady === true,
      failedSteps: Array.isArray(paperOrderMode?.failedSteps) ? paperOrderMode.failedSteps : [],
    },
    liveOrderGate: {
      status: liveOrderGate?.status ?? "unknown",
      liveTradingReady: liveOrderGate?.liveTradingReady === true,
      liveOrdersStatus: liveOrderGate?.liveOrdersStatus ?? null,
      liveOrdersReason: liveOrderGate?.liveOrdersReason ?? null,
      blockerId: liveOrderGate?.blockerId ?? null,
      allowLiveTrading: liveOrderGate?.allowLiveTrading === true,
      writeBrokerOrders: liveOrderGate?.writeBrokerOrders === true,
      sentOrder: liveOrderGate?.sentOrder === true,
      nextRequiredAction: liveOrderGate?.nextRequiredAction ?? null,
    },
  };
}

function summarizeBlackboxAutonomyReport(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    schema: payload?.schema ?? "missing",
    cycleId: payload?.cycleId ?? "",
    generatedCandidates:
      typeof payload?.generatedCandidates === "number"
        ? payload.generatedCandidates
        : Array.isArray(payload?.candidates)
          ? payload.candidates.length
          : 0,
    acceptedCount: Array.isArray(payload?.accepted) ? payload.accepted.length : 0,
    rejectedCount: Array.isArray(payload?.rejected) ? payload.rejected.length : 0,
    hardStop: payload?.hardStop === true,
    nextSafeTask: payload?.nextSafeTask ?? "",
    noOrderWrite:
      payload?.safety?.noOrderWrite === true ||
      (typeof payload?.machineLine === "string" &&
        payload.machineLine.includes("noOrderWrite=true")),
    allowLiveTrading:
      payload?.safety?.allowLiveTrading === true ||
      (typeof payload?.machineLine === "string" &&
        payload.machineLine.includes("allowLiveTrading=true")),
    machineLine: payload?.machineLine ?? "",
    generatedAt: payload?.generatedAt ?? null,
  };
}

function summarizeBlackboxSyncReport(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    schema: payload?.schema ?? "missing",
    syncStatus: payload?.syncStatus ?? "missing",
    upstreamVersion: payload?.upstreamVersion ?? "",
    downstreamVersion: payload?.downstreamVersion ?? "",
    lastAckAt: payload?.lastAckAt ?? null,
    machineLine: payload?.machineLine ?? "",
  };
}

async function loadCapitalLiveTradingApprovalSummary(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_LIVE_TRADING_APPROVAL_SUMMARY_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalLiveTradingApprovalSummary(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    telegramSummary: payload?.telegram_summary_oneline_zh_tw ?? "",
    approval: {
      humanApproved: payload?.approval?.humanApproved === true,
      accountAllowlistCount: Number.isFinite(Number(payload?.approval?.accountAllowlistCount))
        ? Number(payload.approval.accountAllowlistCount)
        : 0,
      killSwitch: payload?.approval?.killSwitch === true,
      rollbackPlanFilled: payload?.approval?.rollbackPlanFilled === true,
      manualOperatorConfirmed: payload?.approval?.manualOperatorConfirmed === true,
    },
    liveGate: {
      status: payload?.liveGate?.status ?? "missing",
      blockerCode: payload?.liveGate?.blockerCode ?? "",
      blockers: Array.isArray(payload?.liveGate?.blockers) ? payload.liveGate.blockers : [],
      readyForManualReview: payload?.liveGate?.readyForManualReview === true,
    },
    safety: {
      liveTradingEnabled: payload?.safety?.liveTradingEnabled === true,
      writeTradingEnabled: payload?.safety?.writeTradingEnabled === true,
      externalWriteEnabled: payload?.safety?.externalWriteEnabled === true,
      brokerOrderPathEnabled: payload?.safety?.brokerOrderPathEnabled === true,
      loginAttempted: payload?.safety?.loginAttempted === true,
      sentOrder: payload?.safety?.sentOrder === true,
      readOnlyReportOnly: payload?.safety?.readOnlyReportOnly === true,
    },
    nextSafeTask: payload?.nextSafeTask ?? "",
  };
}

async function loadCapitalLiveTradingApprovalTelegramPublish(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_LIVE_TRADING_APPROVAL_TELEGRAM_PUBLISH_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalLiveTradingApprovalTelegramPublish(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    errorCode: payload?.errorCode ?? "",
    dryRun: payload?.dryRun === true,
    dryRunNoSend: payload?.dryRunNoSend === true,
    targetSource: payload?.targetSource ?? "",
    commandExitCode: typeof payload?.commandExitCode === "number" ? payload.commandExitCode : null,
    commandErrorCode: payload?.commandErrorCode ?? "",
    message: payload?.message ?? "",
  };
}

async function loadCapitalLiveTradingOperatorAutoDeactivate(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalLiveTradingOperatorAutoDeactivate(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    schema: payload?.schema ?? "missing",
    status: payload?.status ?? "missing",
    execute: payload?.execute === true,
    applied: payload?.applied === true,
    enabledAfter: payload?.enabledAfter === true,
    activationExpired: payload?.activationExpired === true,
    activationExpiresAt: String(payload?.activationExpiresAt || ""),
    sentOrder: payload?.sentOrder === true,
    noOrderWrite: payload?.noOrderWrite === true,
    operatorActionRequired: payload?.operatorActionRequired === true,
    operatorActionCommand: String(payload?.operatorActionCommand || ""),
    operatorActionReason: String(payload?.operatorActionReason || ""),
    operatorActionAuditId: String(payload?.operatorActionAuditId || ""),
    operatorActionRequiresExplicitExecute: payload?.operatorActionRequiresExplicitExecute === true,
    operatorActionHeartbeatExecuteAllowed: payload?.operatorActionHeartbeatExecuteAllowed === true,
    operatorActionReceiptId: String(payload?.operatorActionReceipt?.id || ""),
    operatorActionReceiptRiskControlsChanged:
      payload?.operatorActionReceipt?.riskControlsChanged === true,
    operatorActionReceiptRollbackPolicy: String(
      payload?.operatorActionReceipt?.rollbackPolicy || "",
    ),
    blockerCode: payload?.blockerCode ?? "",
    blockers: Array.isArray(payload?.blockers) ? payload.blockers : [],
    nextSafeTask: payload?.nextSafeTask ?? "",
  };
}

async function loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate(repoRoot) {
  const latestPath = path.join(
    repoRoot,
    CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_RECEIPT_GATE_REL,
  );
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    schema: payload?.schema ?? "missing",
    status: payload?.status ?? "missing",
    auditId: String(payload?.auditId || ""),
    pendingExplicitExecuteReceipt: payload?.pendingExplicitExecuteReceipt === true,
    receiptVerified: payload?.receiptVerified === true,
    heartbeatExecuteAllowed: payload?.heartbeatExecuteAllowed === true,
    noLiveOrderSent: payload?.safety?.noLiveOrderSent === true,
    sentOrder: payload?.safety?.sentOrder === true,
    blockers: Array.isArray(payload?.blockers) ? payload.blockers : [],
    machineLine: String(payload?.machineLine || ""),
    nextSafeTask: payload?.nextSafeTask ?? "",
  };
}

function isCapitalLiveTradingOperatorAutoDeactivateReceiptPending(summary) {
  return (
    summary?.exists === true &&
    summary.pendingExplicitExecuteReceipt === true &&
    summary.receiptVerified === false
  );
}

async function loadCapitalTelegramOwnerCheck(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_TELEGRAM_OWNER_CHECK_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalTelegramOwnerCheck(latest) {
  const payload = latest?.payload ?? {};
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    ready: payload?.ready === true,
    generatedAt: payload?.generatedAt ?? null,
    expectedReceiver: payload?.expectedReceiver ?? "openclaw_gateway",
    receiver: payload?.receiver ?? "unknown",
    receiverLabel: payload?.receiverLabel ?? payload?.receiver ?? "unknown",
    capitalMode: payload?.capitalMode ?? "unknown",
    secondPoller: payload?.secondPoller ?? "unknown",
    blockerCode: payload?.blockerCode ?? "",
    fix: payload?.fix ?? "",
    pollerSummary: payload?.pollerSummary ?? "missing",
    readOnly: payload?.readOnly === true,
    liveTradingEnabled: payload?.liveTradingEnabled === true,
    writeTradingEnabled: payload?.writeTradingEnabled === true,
    replyLine: payload?.replyLine ?? "",
    poller: {
      available: payload?.poller?.available === true,
      pollingEnabled: payload?.poller?.pollingEnabled === true,
      pollingOwner: payload?.poller?.pollingOwner ?? "missing",
      pollState: payload?.poller?.pollState ?? "missing",
      duplicatePollerDetected: payload?.poller?.duplicatePollerDetected === true,
      duplicatePollerCount: Number.isFinite(Number(payload?.poller?.duplicatePollerCount))
        ? Number(payload.poller.duplicatePollerCount)
        : 0,
      consecutivePollErrors: Number.isFinite(Number(payload?.poller?.consecutivePollErrors))
        ? Number(payload.poller.consecutivePollErrors)
        : 0,
    },
  };
}

async function loadCapitalCoreProductFreshnessMatrix(repoRoot) {
  const latestPath = path.join(repoRoot, CAPITAL_CORE_PRODUCT_FRESHNESS_MATRIX_REL);
  const payload = await readJson(latestPath);
  return {
    path: latestPath,
    exists: payload !== null,
    payload,
  };
}

function summarizeCapitalCoreProductFreshnessMatrix(latest) {
  const payload = latest?.payload ?? {};
  const products = Array.isArray(payload?.products) ? payload.products : [];
  return {
    exists: latest?.exists === true,
    path: latest?.path ?? null,
    status: payload?.status ?? "missing",
    ready: payload?.ready === true,
    generatedAt: payload?.generatedAt ?? null,
    maxFreshSeconds: typeof payload?.maxFreshSeconds === "number" ? payload.maxFreshSeconds : null,
    summary: {
      productCount:
        typeof payload?.summary?.productCount === "number" ? payload.summary.productCount : 0,
      requiredCount:
        typeof payload?.summary?.requiredCount === "number" ? payload.summary.requiredCount : 0,
      freshCount: typeof payload?.summary?.freshCount === "number" ? payload.summary.freshCount : 0,
      requiredReady: payload?.summary?.requiredReady === true,
      blockedRequiredIds: Array.isArray(payload?.summary?.blockedRequiredIds)
        ? payload.summary.blockedRequiredIds
        : [],
    },
    products: products.map((product) => ({
      id: product?.id ?? "",
      label: product?.label ?? "",
      market: product?.market ?? "",
      status: product?.status ?? "unknown",
      ready: product?.ready === true,
      required: product?.required === true,
      matchedSymbol: product?.matchedSymbol ?? "",
      ageSeconds: typeof product?.ageSeconds === "number" ? product.ageSeconds : null,
      bid: typeof product?.quote?.bid === "number" ? product.quote.bid : null,
      ask: typeof product?.quote?.ask === "number" ? product.quote.ask : null,
      close: typeof product?.quote?.close === "number" ? product.quote.close : null,
    })),
  };
}

function formatCapitalTelegramOwnerStatus(ownerCheck) {
  if (!ownerCheck?.exists) {
    return "unavailable";
  }
  const owner = ownerCheck.receiver || "unknown";
  const mode = ownerCheck.capitalMode || "unknown";
  const summary = ownerCheck.pollerSummary || "missing";
  if (ownerCheck.ready) {
    return `READY:${owner}/${mode}/${summary}`;
  }
  return `BLOCKED:${ownerCheck.blockerCode || ownerCheck.status || "unknown"}/${mode}/${summary}`;
}

function formatLiveOrderGateStatus(capitalPaperAssistantState) {
  const gate = capitalPaperAssistantState?.liveOrderGate;
  if (!capitalPaperAssistantState?.exists || !gate) {
    return "unavailable";
  }
  if (gate.liveTradingReady) {
    return "READY";
  }
  return `BLOCKED:${gate.blockerId || gate.liveOrdersReason || gate.status || "unknown"}`;
}

function formatCapitalLiveApprovalStatus(liveApprovalSummary, capitalPaperAssistantState) {
  if (liveApprovalSummary?.exists) {
    const blockers = Array.isArray(liveApprovalSummary.liveGate?.blockers)
      ? liveApprovalSummary.liveGate.blockers
      : [];
    const blockerText =
      blockers.length > 0
        ? blockers.join(",")
        : liveApprovalSummary.liveGate?.blockerCode || liveApprovalSummary.status || "unknown";
    const approval = liveApprovalSummary.approval ?? {};
    const rollbackText = approval.rollbackPlanFilled ? "filled" : "missing";
    if (liveApprovalSummary.liveGate?.readyForManualReview === true) {
      return `MANUAL_REVIEW:${blockerText};humanApproved=${String(approval.humanApproved === true)};allowlist=${String(approval.accountAllowlistCount ?? 0)};rollback=${rollbackText}`;
    }
    return `BLOCKED:${blockerText};humanApproved=${String(approval.humanApproved === true)};allowlist=${String(approval.accountAllowlistCount ?? 0)};rollback=${rollbackText}`;
  }
  return formatLiveOrderGateStatus(capitalPaperAssistantState);
}

function formatCapitalLiveApprovalTelegramPublishStatus(summary) {
  if (!summary?.exists) {
    return "unavailable";
  }
  if (summary.status === "dry_run_ok" && summary.dryRunNoSend === true) {
    return `DRY_RUN_OK:no_send/${summary.targetSource || "unknown"}`;
  }
  return `${summary.status || "unknown"}:${summary.errorCode || summary.commandErrorCode || "unknown"}`;
}

function formatCapitalLiveTradingOperatorAutoDeactivateStatus(summary) {
  if (!summary?.exists) {
    return "unavailable";
  }
  const blockerText =
    Array.isArray(summary.blockers) && summary.blockers.length > 0
      ? summary.blockers.join(",")
      : summary.blockerCode || "none";
  return [
    `autoDeactivate=${summary.status || "unknown"}`,
    `execute=${String(summary.execute === true)}`,
    `applied=${String(summary.applied === true)}`,
    `enabledAfter=${String(summary.enabledAfter === true)}`,
    `activationExpired=${String(summary.activationExpired === true)}`,
    `sentOrder=${String(summary.sentOrder === true)}`,
    `operatorActionRequired=${String(summary.operatorActionRequired === true)}`,
    `operatorAction=${summary.operatorActionCommand || "none"}`,
    `operatorReason=${summary.operatorActionReason || "none"}`,
    `operatorAudit=${summary.operatorActionAuditId || "none"}`,
    `operatorExplicitExecute=${String(summary.operatorActionRequiresExplicitExecute === true)}`,
    `heartbeatExecuteAllowed=${String(summary.operatorActionHeartbeatExecuteAllowed === true)}`,
    `operatorReceipt=${summary.operatorActionReceiptId || "none"}`,
    `receiptRiskChanged=${String(summary.operatorActionReceiptRiskControlsChanged === true)}`,
    `receiptRollback=${summary.operatorActionReceiptRollbackPolicy || "none"}`,
    `blockers=${blockerText}`,
  ].join(" ");
}

function formatCapitalLiveTradingOperatorAutoDeactivateReceiptGateStatus(summary) {
  if (!summary?.exists) {
    return "unavailable";
  }
  const blockersText =
    Array.isArray(summary.blockers) && summary.blockers.length > 0
      ? summary.blockers.join(",")
      : "none";
  return [
    `autoDeactivateReceipt=${summary.status || "unknown"}`,
    `audit=${summary.auditId || "missing"}`,
    `pendingExplicitExecuteReceipt=${String(summary.pendingExplicitExecuteReceipt === true)}`,
    `receiptVerified=${String(summary.receiptVerified === true)}`,
    `heartbeatExecuteAllowed=${String(summary.heartbeatExecuteAllowed === true)}`,
    `noLiveOrderSent=${String(summary.noLiveOrderSent === true)}`,
    `sentOrder=${String(summary.sentOrder === true)}`,
    `blockers=${blockersText}`,
  ].join(" ");
}

function buildCapitalLiveTradingOperatorAutoDeactivateReceiptPrompt(summary, nextSafeCommand) {
  const command =
    normalizeTextValue(nextSafeCommand) ??
    "pnpm capital:live-trading:operator:auto-deactivate:receipt:check";
  const pending = isCapitalLiveTradingOperatorAutoDeactivateReceiptPending(summary);
  const verified = summary?.receiptVerified === true;
  const status = pending
    ? "pending_explicit_execute_receipt"
    : verified
      ? "receipt_verified"
      : (normalizeTextValue(summary?.status) ?? "unavailable");
  const action = pending
    ? "verify_receipt_gate"
    : verified
      ? "receipt_verified_no_action"
      : "wait_for_receipt_gate";
  const label = pending
    ? "等待非 heartbeat explicit execute receipt；先檢查收據 gate"
    : verified
      ? "收據已驗證"
      : "等待收據 gate";
  const machineLine = [
    `receiptPrompt=${status}`,
    `action=${action}`,
    `command=${command.replace(/\s+/g, "_")}`,
    `receiptVerified=${String(verified)}`,
    `heartbeatExecuteAllowed=${String(summary?.heartbeatExecuteAllowed === true)}`,
    `noLiveOrderSent=${String(summary?.noLiveOrderSent === true)}`,
    `sentOrder=${String(summary?.sentOrder === true)}`,
  ].join(" ");
  return {
    status,
    action,
    command,
    label,
    pendingExplicitExecuteReceipt: pending,
    receiptVerified: verified,
    heartbeatExecuteAllowed: summary?.heartbeatExecuteAllowed === true,
    noLiveOrderSent: summary?.noLiveOrderSent === true,
    sentOrder: summary?.sentOrder === true,
    machineLine,
  };
}

function formatPaperOrderModeStatus(capitalPaperAssistantState, capitalServiceStatus = null) {
  const replyLine =
    typeof capitalServiceStatus?.replyLine === "string" ? capitalServiceStatus.replyLine : "";
  const serviceOrderMode = replyLine.match(/下單模式=([^｜|]+)/u)?.[1]?.trim() ?? "";
  const serviceOrderModeReady =
    capitalServiceStatus?.exists === true &&
    serviceOrderMode.endsWith(":READY") &&
    replyLine.includes("未送單") &&
    replyLine.includes("不可回舊價");
  if (serviceOrderModeReady) {
    return `READY_BY_SERVICE_STATUS:${serviceOrderMode};sent=false/write=false`;
  }
  const mode = capitalPaperAssistantState?.paperOrderMode;
  if (!capitalPaperAssistantState?.exists || !mode) {
    return "unavailable";
  }
  if (mode.pass && mode.sentOrder === false && mode.liveOrdersEnabledByThisCheck === false) {
    const venues = [
      mode.domesticReady ? "domestic" : "domestic?",
      mode.overseasReady ? "overseas" : "overseas?",
    ].join("+");
    const modes = [
      mode.dayTradeReady ? "day_trade" : "day_trade?",
      mode.overnightReady ? "overnight" : "overnight?",
    ].join("+");
    return `PASS:${venues}/${modes}/sent=false`;
  }
  const failedSteps =
    Array.isArray(mode.failedSteps) && mode.failedSteps.length > 0
      ? mode.failedSteps.join(",")
      : mode.status || "unknown";
  return `BLOCKED:${failedSteps}`;
}

function formatCapitalCoreProductMatrixStatus(matrix) {
  if (!matrix?.exists) {
    return "unavailable";
  }
  const productCount = matrix.summary?.productCount ?? 0;
  const freshCount = matrix.summary?.freshCount ?? 0;
  const requiredCount = matrix.summary?.requiredCount ?? 0;
  const blockedRequiredIds = Array.isArray(matrix.summary?.blockedRequiredIds)
    ? matrix.summary.blockedRequiredIds
    : [];
  const staleOrBlocked = (Array.isArray(matrix.products) ? matrix.products : [])
    .filter((product) => product.status !== "fresh")
    .map((product) => `${product.id}:${product.status}`)
    .join(",");
  if (matrix.ready) {
    return `READY:${freshCount}/${productCount};required=${requiredCount - blockedRequiredIds.length}/${requiredCount}${staleOrBlocked ? `;watch=${staleOrBlocked}` : ""}`;
  }
  return `BLOCKED:${blockedRequiredIds.join(",") || matrix.status || "unknown"}${staleOrBlocked ? `;watch=${staleOrBlocked}` : ""}`;
}

function formatCapitalOverseasStaleRecoveryStatus(summary) {
  if (!summary?.exists) {
    return "unavailable";
  }
  const readyTargets = Array.isArray(summary.readyTargets) ? summary.readyTargets.join(",") : "";
  const staleTargets = Array.isArray(summary.staleTargets) ? summary.staleTargets.join(",") : "";
  const safetyText =
    summary.sentOrder === false &&
    summary.writeBrokerOrders === false &&
    summary.brokerWriteAttempted === false
      ? "sent=false/write=false"
      : "SAFETY_BLOCK";
  if (summary.status === "recovery_executed_ready") {
    return `RECOVERY_EXECUTED_READY:${readyTargets || "none"};${safetyText}`;
  }
  if (summary.status === "recovery_executed_still_blocked") {
    return `RECOVERY_EXECUTED_BLOCKED:${staleTargets || "unknown"};${safetyText}`;
  }
  if (summary.ready && staleTargets.length === 0) {
    return `READY:${readyTargets || "none"};${safetyText}`;
  }
  if (summary.recoveryAllowed) {
    return `RECOVERY_READY:${staleTargets || "unknown"};${safetyText}`;
  }
  const failedSteps =
    Array.isArray(summary.failedSteps) && summary.failedSteps.length > 0
      ? summary.failedSteps.join(",")
      : summary.blockerCode || summary.status || "unknown";
  return `BLOCKED:${failedSteps};${safetyText}`;
}

function deriveCapitalQuickQuoteBlockers(summary) {
  if (!summary.exists) {
    return ["capital_quick_quote_latest_missing"];
  }
  if (summary.reportable) {
    return [];
  }
  const blockers = ["capital_quick_quote_blocked"];
  if (summary.callbackReportableCount === 0) {
    blockers.push("capital_callback_not_reportable");
  }
  if (summary.blockerCode) {
    blockers.push(summary.blockerCode);
  }
  return blockers;
}

function deriveCapitalCoreProductMatrixBlockers(summary) {
  if (!summary.exists) {
    return ["capital_core_product_matrix_missing"];
  }
  if (summary.ready) {
    return [];
  }
  const blockedRequiredIds = Array.isArray(summary.summary?.blockedRequiredIds)
    ? summary.summary.blockedRequiredIds
    : [];
  return blockedRequiredIds.length > 0
    ? blockedRequiredIds.map((id) => `capital_core_product_blocked:${id}`)
    : ["capital_core_product_matrix_blocked"];
}

function isCapitalServiceStatusAuthoritativeReady(summary) {
  return (
    summary?.exists === true &&
    summary?.ready === true &&
    summary?.quoteReady === true &&
    summary?.quoteStatus === "fresh" &&
    summary?.staleQuoteReturned !== true
  );
}

function isCapitalQuoteStatusAuthoritativeReady(summary) {
  return (
    summary?.exists === true &&
    summary?.quoteReady === true &&
    summary?.quoteStatus === "fresh" &&
    summary?.staleQuoteReturned !== true
  );
}

function deriveCapitalTelegramOwnerBlockers(summary) {
  if (!summary.exists) {
    return ["capital_telegram_owner_check_missing"];
  }
  if (summary.ready) {
    return [];
  }
  return [summary.blockerCode || summary.status || "capital_telegram_owner_blocked"];
}

async function chooseNextSafeTask(repoRoot) {
  const state = await loadRunnerState(repoRoot);
  const quoteStatusPath = path.join(repoRoot, QUOTE_STATUS_REL);
  const serviceStatusPath = path.join(repoRoot, CAPITAL_SERVICE_STATUS_REL);
  const quoteStatus = await readJson(quoteStatusPath);
  const serviceStatus = await readJson(serviceStatusPath);
  const legacyQuoteBlockers = deriveQuoteBlockers(quoteStatus);
  const serviceStatusSummary = summarizeCapitalServiceStatus(serviceStatus);
  const serviceStatusBlockers = deriveCapitalServiceStatusBlockers(serviceStatusSummary);
  const overseasStaleRecovery = summarizeCapitalOverseasStaleRecovery(
    await loadCapitalOverseasStaleRecovery(repoRoot),
  );
  const capitalFreshQuoteGate = summarizeCapitalFreshQuoteGateLatest(
    await loadCapitalFreshQuoteGateLatest(),
  );
  const domesticQuoteComGuard = reconcileCapitalDomesticQuoteComGuard(
    summarizeCapitalDomesticQuoteComGuard(await loadCapitalDomesticQuoteComGuard()),
    { freshQuoteGate: capitalFreshQuoteGate, serviceStatus: serviceStatusSummary },
  );
  const overseasStaleRecoveryBlockers = deriveCapitalOverseasStaleRecoveryBlockers(
    overseasStaleRecovery,
    serviceStatusSummary,
  );
  const domesticQuoteComGuardBlockers = deriveCapitalDomesticQuoteComGuardBlockers(
    domesticQuoteComGuard,
    capitalFreshQuoteGate,
  );
  const capitalTelegramOwnerCheck = summarizeCapitalTelegramOwnerCheck(
    await loadCapitalTelegramOwnerCheck(repoRoot),
  );
  const capitalPaperFillSimulation = summarizeCapitalPaperFillSimulation(
    await loadCapitalPaperFillSimulation(repoRoot),
  );
  const capitalPaperStrategyEvaluation = summarizeCapitalPaperStrategyEvaluation(
    await loadCapitalPaperStrategyEvaluation(repoRoot),
  );
  const capitalPaperAutoReview = summarizeCapitalPaperAutoReview(
    await loadCapitalPaperAutoReview(repoRoot),
  );
  const capitalPaperErrorRepair = summarizeCapitalPaperErrorRepair(
    await loadCapitalPaperErrorRepair(repoRoot),
  );
  const blackboxAutonomy = summarizeBlackboxAutonomyReport(
    await loadBlackboxAutonomyReport(repoRoot),
  );
  const blackboxSync = summarizeBlackboxSyncReport(await loadBlackboxSyncReport(repoRoot));
  const capitalStrategyFillSimulation = summarizeCapitalStrategyFillSimulation(
    await loadCapitalStrategyFillSimulation(repoRoot),
  );
  const hermesNuwaBridge = summarizeHermesNuwaBridgeReport(
    await loadHermesNuwaBridgeReport(repoRoot),
  );
  const capitalLiveTradingOperatorAutoDeactivateReceiptGate =
    summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
      await loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate(repoRoot),
    );
  const quoteBlockers = serviceStatusSummary.exists
    ? [...serviceStatusBlockers, ...overseasStaleRecoveryBlockers, ...domesticQuoteComGuardBlockers]
    : [
        ...legacyQuoteBlockers,
        ...serviceStatusBlockers,
        ...overseasStaleRecoveryBlockers,
        ...domesticQuoteComGuardBlockers,
      ];
  const marketBlocked = quoteBlockers.length > 0;
  const riskControlsObservedBlocked =
    serviceStatusSummary.riskControlsObservedLive || serviceStatusSummary.riskControlsObservedWrite;
  const autoDeactivateReceiptPending = isCapitalLiveTradingOperatorAutoDeactivateReceiptPending(
    capitalLiveTradingOperatorAutoDeactivateReceiptGate,
  );
  const riskControlsObservedTaskId = autoDeactivateReceiptPending
    ? "capital_live_trading_operator_auto_deactivate_receipt_check"
    : "capital_live_trading_operator_auto_deactivate";
  const taskPool = marketBlocked
    ? riskControlsObservedBlocked
      ? prioritizeTask(RESILIENCE_HARDENING_TASKS, riskControlsObservedTaskId)
      : overseasStaleRecoveryBlockers.length > 0
        ? prioritizeTask(RESILIENCE_HARDENING_TASKS, "capital_overseas_stale_recovery")
        : domesticQuoteComGuard.restartRequired && !capitalFreshQuoteGate.ready
          ? prioritizeTask(RESILIENCE_HARDENING_TASKS, "capital_domestic_quote_com_guard_recovery")
          : RESILIENCE_HARDENING_TASKS
    : MARKET_MONITOR_TASKS;
  const lane = marketBlocked ? "resilience_hardening" : "market_monitor";
  const laneState = state.payload?.lastTaskIdByLane;
  const lastTaskIdForLane =
    laneState && typeof laneState === "object" && typeof laneState[lane] === "string"
      ? laneState[lane]
      : (state.payload?.lastTaskId ?? null);
  const readOnlyMode = true;
  const reason = riskControlsObservedBlocked
    ? autoDeactivateReceiptPending
      ? "risk-controls live/write observed and auto-deactivate receipt is pending; verify receipt gate before repeating auto-deactivate"
      : "risk-controls live/write observed; generate operator auto-deactivate report before live-readiness retry"
    : marketBlocked
      ? "quote freshness or session gate blocked; run highest-value read-only hardening task"
      : "quote/session gate ready; run read-only market monitor task";
  const nuwaPatterns = await queryNuwaPatterns(lane);
  const completionContext = {
    capitalServiceStatus: serviceStatusSummary,
    capitalOverseasStaleRecovery: overseasStaleRecovery,
    capitalDomesticQuoteComGuard: domesticQuoteComGuard,
    capitalFreshQuoteGate,
    capitalTelegramOwnerCheck,
    capitalPaperFillSimulation,
    capitalPaperStrategyEvaluation,
    capitalPaperAutoReview,
    capitalPaperErrorRepair,
    blackboxAutonomy,
    blackboxSync,
    capitalStrategyFillSimulation,
    hermesNuwaBridge,
    capitalLiveTradingOperatorAutoDeactivateReceiptGate,
    autonomousInventory: await collectAutonomousInventory(repoRoot),
  };
  const candidateTask = riskControlsObservedBlocked
    ? taskPool[0]
    : domesticQuoteComGuard.restartRequired
      ? taskPool[0]
      : pickNextIncompleteTask(taskPool, lastTaskIdForLane, completionContext, nuwaPatterns);
  const { task, reason: resolvedReason } = await resolveTaskWithTimeoutBackoff(
    repoRoot,
    taskPool,
    candidateTask,
    reason,
  );
  return {
    task,
    taskPool,
    lane,
    readOnlyMode,
    reason: resolvedReason,
    quoteStatus,
    serviceStatus: serviceStatusSummary,
    quoteBlockers,
    runnerState: state,
  };
}

async function saveRunnerState(statePath, taskId, runCount, lane, previousState) {
  const lastTaskIdByLane =
    previousState?.lastTaskIdByLane && typeof previousState.lastTaskIdByLane === "object"
      ? { ...previousState.lastTaskIdByLane }
      : {};
  if (lane) {
    lastTaskIdByLane[lane] = taskId;
  }
  const payload = {
    schema: STATE_SCHEMA,
    updatedAt: new Date().toISOString(),
    lastTaskId: taskId,
    lastTaskIdByLane,
    runCount,
  };
  await writeJson(statePath, payload);
  return payload;
}

// ── Hermes 學習記錄自動橋接（每次受控任務完成後寫入 learning-state.json）───────
export async function autoHermesLearn(repoRoot, task, exitCode, report) {
  try {
    const statePath = path.join(repoRoot, STATE_DIR_REL, "learning-state.json");
    const MAX_RECORDS = 200;

    // 讀取現有學習狀態（首次建立時從空白開始）
    let state = {
      version: 1,
      success_patterns: [],
      failure_patterns: [],
      updated_at: new Date(0).toISOString(),
    };
    try {
      const raw = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (raw?.version === 1) {
        state = {
          version: 1,
          success_patterns: Array.isArray(raw.success_patterns) ? raw.success_patterns : [],
          failure_patterns: Array.isArray(raw.failure_patterns) ? raw.failure_patterns : [],
          updated_at:
            typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString(),
        };
      }
    } catch {
      /* 首次建立，使用空白初始狀態 */
    }

    const blockers = Array.isArray(report?.remaining_blockers) ? report.remaining_blockers : [];
    const durationMs = report?.task?.durationMs ?? 0;
    const traceId = `controlled-task-runner-${task.id}-${nowId()}`;
    const record = {
      trace_id: traceId,
      decision_id: `controlled-task-runner:${traceId}`,
      decision_version: 1,
      source: "controlled-task-runner",
      adopted_by: exitCode === 0 ? "controlled-task-runner" : null,
      rollback_pointer: {
        kind: "controlled-task-runner-record",
        trace_id: traceId,
        task_id: task.id,
      },
      status: exitCode === 0 ? "success" : "failure",
      summary: [
        `任務 ${task.id}（${task.label}）`,
        exitCode === 0 ? "通過" : `失敗 exit=${String(exitCode)}`,
        `耗時 ${durationMs}ms`,
        blockers.length > 0 ? `阻塞: ${blockers.slice(0, 3).join(", ")}` : "無阻塞",
      ].join(" ｜ "),
      created_at: new Date().toISOString(),
      tags: ["controlled-task-runner", task.id, exitCode === 0 ? "pass" : "fail"],
    };

    const trim = (arr) => (arr.length <= MAX_RECORDS ? arr : arr.slice(arr.length - MAX_RECORDS));
    if (exitCode === 0) {
      state.success_patterns = trim([...state.success_patterns, record]);
    } else {
      state.failure_patterns = trim([...state.failure_patterns, record]);
    }
    state.updated_at = new Date().toISOString();

    await writeJson(statePath, state);
  } catch {
    // 靜默失敗，不阻斷主流程
  }
}

async function writeRunReport(repoRoot, report) {
  const stateDir = path.join(repoRoot, STATE_DIR_REL);
  await fs.mkdir(stateDir, { recursive: true });

  const runId = nowId();
  const runFileName = `openclaw-controlled-task-runner-${runId}.json`;
  const runPath = path.join(stateDir, runFileName);
  const latestPath = path.join(stateDir, LATEST_REPORT_NAME);
  await writeJson(runPath, report);
  await writeJson(latestPath, report);
  return {
    runPath: toPosix(path.relative(repoRoot, runPath)),
    latestPath: toPosix(path.relative(repoRoot, latestPath)),
  };
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOkxHeartbeatPublishTokenCountsStatus(telegramPublishReport) {
  const messageTokenCounts =
    telegramPublishReport !== null && typeof telegramPublishReport === "object"
      ? telegramPublishReport.messageTokenCounts
      : null;
  const summaryZhTw =
    normalizeTextValue(telegramPublishReport?.messageTokenCountsSummaryZhTw) ??
    "messageTokenCounts unavailable";
  const noOrderWriteCount = numericOrNull(messageTokenCounts?.noOrderWrite);
  const positionSnapshotCount = numericOrNull(messageTokenCounts?.positionSnapshot);
  const dmadGateCount = numericOrNull(messageTokenCounts?.dmadGate);
  return {
    exists: telegramPublishReport !== null && typeof telegramPublishReport === "object",
    status: normalizeTextValue(telegramPublishReport?.status) ?? "missing",
    dryRun: telegramPublishReport?.dryRun === true,
    summaryZhTw,
    machineLine: summaryZhTw,
    noOrderWriteCount,
    positionSnapshotCount,
    dmadGateCount,
    executeRequiredCount: numericOrNull(messageTokenCounts?.executeRequired),
    noOrderWriteVerified: noOrderWriteCount === 4 && summaryZhTw.includes("noOrderWrite=true=4"),
    positionSnapshotVerified: positionSnapshotCount === 1 && summaryZhTw.includes("倉位快照=1"),
    dmadGateVerified: dmadGateCount === 1 && summaryZhTw.includes("DMAD=1"),
    reportPath: `${STATE_DIR_REL}/${TELEGRAM_PUBLISH_REPORT_NAME}`,
  };
}

function buildCapitalOperatorPacketStatus(closure) {
  const exists = closure !== null && typeof closure === "object";
  const machineLine =
    normalizeTextValue(closure?.machineLine) ??
    `capitalOperatorPacket=missing operatorCanExecute=${String(closure?.operatorCanExecute === true)} sentOrder=${String(closure?.sentOrder === true)}`;
  const blockers = Array.isArray(closure?.blockers)
    ? closure.blockers.filter((blocker) => typeof blocker === "string" && blocker.trim().length > 0)
    : [];
  const packetStatus =
    machineLine.match(/\bcapitalOperatorPacket=([^\s｜|]+)/u)?.[1] ??
    normalizeTextValue(closure?.packetStatus) ??
    normalizeTextValue(closure?.status) ??
    "missing";
  const readinessStatus =
    normalizeTextValue(closure?.readinessStatus) ??
    machineLine.match(/\breadiness=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const adapterAckStatus =
    normalizeTextValue(closure?.adapterAckStatus) ??
    machineLine.match(/\badapterAck=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const adapterApplyReceiptStatus =
    normalizeTextValue(closure?.adapterApplyReceiptStatus) ??
    machineLine.match(/\badapterApplyReceipt=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const adapterApplyReceiptVerified =
    closure?.adapterApplyReceiptVerified === true ||
    machineLine.includes("adapterApplyReceiptVerified=true");
  const adapterApplyReceiptOperatorMayApply =
    closure?.adapterApplyReceiptOperatorMayApply === true ||
    machineLine.includes("operatorMayApply=true") ||
    machineLine.includes("adapterApplyReceiptOperatorMayApply=true");
  const dispatchPolicy =
    normalizeTextValue(closure?.dispatchPolicy) ??
    machineLine.match(/\bdispatch(?:Policy)?=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const operatorCanExecute =
    closure?.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true");
  const noOrderWrite = closure?.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
  const sentOrder = closure?.sentOrder === true || machineLine.includes("sentOrder=true");
  const blockerCount = numericOrNull(closure?.blockerCount) ?? blockers.length;
  const publishMachineLine = [
    `capitalOperatorPacket=${packetStatus}`,
    `operatorCanExecute=${String(operatorCanExecute)}`,
    `readiness=${readinessStatus}`,
    `adapterAck=${adapterAckStatus}`,
    `adapterApplyReceipt=${adapterApplyReceiptStatus}`,
    `adapterApplyReceiptVerified=${String(adapterApplyReceiptVerified)}`,
    `operatorMayApply=${String(adapterApplyReceiptOperatorMayApply)}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `sentOrder=${String(sentOrder)}`,
    `blockers=${String(blockerCount)}`,
  ].join(" ");
  return {
    exists,
    status: normalizeTextValue(closure?.status) ?? "missing",
    reportRead: closure?.reportRead === true,
    machineLine,
    publishMachineLine,
    packetStatus,
    readinessStatus,
    adapterAckStatus,
    adapterApplyReceiptStatus,
    adapterApplyReceiptVerified,
    adapterApplyReceiptOperatorMayApply,
    dispatchPolicy,
    operatorCanExecute,
    noOrderWrite,
    sentOrder,
    blockerCount,
    blockers,
    reportPath:
      normalizeTextValue(closure?.reportPath) ??
      "reports/hermes-agent/state/openclaw-capital-live-operator-execution-packet-latest.json",
  };
}

function buildCapitalLocalExecutorDispatchStatus(closure) {
  const exists = closure !== null && typeof closure === "object";
  const machineLine =
    normalizeTextValue(closure?.machineLine) ??
    `capitalLocalExecutorDispatch=missing operatorCanExecute=${String(closure?.operatorCanExecute === true)} executorArmed=${String(closure?.executorArmed === true)} sentOrder=${String(closure?.sentOrder === true)}`;
  const blockers = Array.isArray(closure?.blockers)
    ? closure.blockers.filter((blocker) => typeof blocker === "string" && blocker.trim().length > 0)
    : [];
  const dispatchStatus =
    machineLine.match(/\bcapitalLocalExecutorDispatch=([^\s｜|]+)/u)?.[1] ??
    normalizeTextValue(closure?.dispatchStatus) ??
    normalizeTextValue(closure?.status) ??
    "missing";
  const dispatchPolicy =
    normalizeTextValue(closure?.dispatchPolicy) ??
    machineLine.match(/\bdispatchPolicy=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const operatorCanExecute =
    closure?.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true");
  const executorArmed =
    closure?.executorArmed === true || machineLine.includes("executorArmed=true");
  const noOrderWrite = closure?.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
  const sentOrder = closure?.sentOrder === true || machineLine.includes("sentOrder=true");
  const blockerCount = numericOrNull(closure?.blockerCount) ?? blockers.length;
  const publishMachineLine = [
    `capitalLocalExecutorDispatch=${dispatchStatus}`,
    `operatorCanExecute=${String(operatorCanExecute)}`,
    `executorArmed=${String(executorArmed)}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `sentOrder=${String(sentOrder)}`,
    `blockers=${String(blockerCount)}`,
    `noOrderWrite=${String(noOrderWrite)}`,
  ].join(" ");
  return {
    exists,
    status: normalizeTextValue(closure?.status) ?? "missing",
    reportRead: closure?.reportRead === true,
    machineLine,
    publishMachineLine,
    dispatchStatus,
    dispatchPolicy,
    operatorCanExecute,
    executorArmed,
    noOrderWrite,
    sentOrder,
    blockerCount,
    blockers,
    sealedOrderIntentSha256: normalizeTextValue(closure?.sealedOrderIntentSha256) ?? "",
    payloadHash: normalizeTextValue(closure?.payloadHash) ?? "",
    reportPath:
      normalizeTextValue(closure?.reportPath) ??
      "reports/hermes-agent/state/openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  };
}

function buildCapitalTradeAutoCycleStatus(closure) {
  const exists = closure !== null && typeof closure === "object";
  const machineLine =
    normalizeTextValue(closure?.machineLine) ??
    `capitalTradeAutoCycle=missing operatorCanExecute=${String(closure?.operatorCanExecute === true)} sentOrder=${String(closure?.sentOrder === true)}`;
  const reportStatus =
    machineLine.match(/\bcapitalTradeAutoCycle=([^\s｜|]+)/u)?.[1] ??
    normalizeTextValue(closure?.reportStatus) ??
    "missing";
  const decisionStatus =
    normalizeTextValue(closure?.decisionStatus) ??
    machineLine.match(/\bdecision=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const quoteFreshness =
    normalizeTextValue(closure?.quoteFreshness) ??
    machineLine.match(/\bquote=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const adapterAckStatus =
    normalizeTextValue(closure?.externalBrokerAdapterAckStatus) ??
    machineLine.match(/\badapterAck=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const strategyFillGate =
    normalizeTextValue(closure?.strategyFillGate) ??
    machineLine.match(/\bstrategyFillGate=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const dispatchPolicy =
    normalizeTextValue(closure?.dispatchPolicy) ??
    machineLine.match(/\bdispatch=([^\s｜|]+)/u)?.[1] ??
    "unknown";
  const operatorCanExecute =
    closure?.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true");
  const canTradeInsideOpenClaw =
    closure?.canTradeInsideOpenClaw === true || machineLine.includes("canTradeInsideOpenClaw=true");
  const noLiveOrderSent =
    closure?.noLiveOrderSent === true || machineLine.includes("noLiveOrderSent=true");
  const noOrderWrite = closure?.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
  const sentOrder = closure?.sentOrder === true || machineLine.includes("sentOrder=true");
  const publishMachineLine = [
    `capitalTradeAutoCycle=${reportStatus}`,
    `decision=${decisionStatus}`,
    `quote=${quoteFreshness}`,
    `adapterAck=${adapterAckStatus}`,
    `strategyFillGate=${strategyFillGate}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `operatorCanExecute=${String(operatorCanExecute)}`,
    `canTradeInsideOpenClaw=${String(canTradeInsideOpenClaw)}`,
    `noLiveOrderSent=${String(noLiveOrderSent)}`,
    `sentOrder=${String(sentOrder)}`,
  ].join(" ");
  return {
    exists,
    status: normalizeTextValue(closure?.status) ?? "missing",
    reportRead: closure?.reportRead === true,
    machineLine,
    publishMachineLine,
    reportStatus,
    decisionStatus,
    quoteFreshness,
    adapterAckStatus,
    strategyFillGate,
    dispatchPolicy,
    operatorCanExecute,
    canTradeInsideOpenClaw,
    noLiveOrderSent,
    noOrderWrite,
    sentOrder,
    reportPath:
      normalizeTextValue(closure?.reportPath) ??
      "reports/hermes-agent/state/openclaw-capital-trade-auto-cycle-latest.json",
  };
}

function buildTelegramTradingShortcutsStatus(tradingShortcutsReport) {
  const summary = tradingShortcutsReport?.summary ?? null;
  const shortcutCheckCountClosure = summary?.shortcutCheckCountClosure ?? null;
  const assistantLearningHint = summary?.assistantClosure?.assistantLearningHint ?? null;
  const nextCommandShortRow = assistantLearningHint?.nextCommandShortRow ?? null;
  const okxRefreshWorkflow = buildOkxCurrentReadinessRefreshWorkflowStatus(
    summary?.okxCurrentReadinessRefreshWorkflowClosure ?? null,
  );
  const okxHeartbeatOperation = buildOkxCurrentReadinessHeartbeatOperationStatus(
    summary?.okxCurrentReadinessHeartbeatOperationClosure ?? null,
  );
  const capitalOperatorPacket = buildCapitalOperatorPacketStatus(
    summary?.capitalOperatorPacketClosure ?? null,
  );
  const capitalLocalExecutorDispatch = buildCapitalLocalExecutorDispatchStatus(
    summary?.capitalLocalExecutorDispatchClosure ?? null,
  );
  const capitalTradeAutoCycle = buildCapitalTradeAutoCycleStatus(
    summary?.capitalTradeAutoCycleClosure ?? null,
  );
  const capitalTailRiskRepairClosure = summary?.capitalTailRiskRepairClosure ?? null;
  const capitalFailedReplayHistoryMachineLine =
    normalizeTextValue(capitalTailRiskRepairClosure?.failedReplayHistoryMachineLine) ??
    "capitalFailedReplayHistory=banned:none next=none skipped=0 available=0 sameCase=missing quality=missing source=missing noOrderWrite=false";
  const capitalTailRiskNextCommandMachineLine =
    normalizeTextValue(capitalTailRiskRepairClosure?.nextCommandMachineLine) ??
    "capitalTailRiskNextCommand=missing command=missing validation=missing repair=missing riskReview=missing actionable=0";
  const capitalRiskResizedRejectionClosure = summary?.capitalRiskResizedRejectionClosure ?? null;
  const capitalRiskResizedRejectionMachineLine =
    normalizeTextValue(capitalRiskResizedRejectionClosure?.machineLine) ??
    "riskResizedRejectionSummary=missing;rejected=none;p05Pts=none;p05Notional=none;next=missing;noOrderWrite=true";
  const capitalRiskResizedRejectionPublishMachineLine =
    normalizeTextValue(capitalRiskResizedRejectionClosure?.publishMachineLine) ??
    "riskResizedRejectionSummary=missing;rejected=none;p05Pts=none;p05Notional=none;next=missing;noOrderWrite:ok";
  return {
    exists: tradingShortcutsReport !== null && typeof tradingShortcutsReport === "object",
    status: normalizeTextValue(tradingShortcutsReport?.status) ?? "missing",
    checks: numericOrNull(summary?.checks),
    failed: numericOrNull(summary?.failed),
    machineLine: normalizeTextValue(shortcutCheckCountClosure?.machineLine) ?? "unavailable",
    nextCommand:
      normalizeTextValue(nextCommandShortRow?.command) ??
      normalizeTextValue(assistantLearningHint?.nextSafeCommand) ??
      "unavailable",
    nextCommandMachineLine:
      normalizeTextValue(nextCommandShortRow?.machineLine) ??
      normalizeTextValue(nextCommandShortRow?.command) ??
      normalizeTextValue(assistantLearningHint?.nextSafeCommand) ??
      "unavailable",
    gateVerified: nextCommandShortRow?.gateVerified === true,
    okxCurrentReadinessRefreshWorkflow: okxRefreshWorkflow,
    okxCurrentReadinessHeartbeatOperation: okxHeartbeatOperation,
    okxHeartbeatRefreshMachineLine: okxHeartbeatOperation.refreshMachineLine,
    okxHeartbeatExecuteRequired: okxHeartbeatOperation.executeRequired,
    okxHeartbeatNoOrderWrite: okxHeartbeatOperation.noOrderWrite,
    capitalOperatorPacket,
    capitalOperatorPacketMachineLine: capitalOperatorPacket.machineLine,
    capitalOperatorPacketPublishMachineLine: capitalOperatorPacket.publishMachineLine,
    capitalOperatorPacketOperatorCanExecute: capitalOperatorPacket.operatorCanExecute,
    capitalOperatorPacketNoOrderWrite: capitalOperatorPacket.noOrderWrite,
    capitalOperatorPacketSentOrder: capitalOperatorPacket.sentOrder,
    capitalOperatorPacketAdapterApplyReceiptStatus: capitalOperatorPacket.adapterApplyReceiptStatus,
    capitalOperatorPacketAdapterApplyReceiptVerified:
      capitalOperatorPacket.adapterApplyReceiptVerified,
    capitalOperatorPacketAdapterApplyReceiptOperatorMayApply:
      capitalOperatorPacket.adapterApplyReceiptOperatorMayApply,
    capitalLocalExecutorDispatch,
    capitalLocalExecutorDispatchMachineLine: capitalLocalExecutorDispatch.machineLine,
    capitalLocalExecutorDispatchPublishMachineLine: capitalLocalExecutorDispatch.publishMachineLine,
    capitalLocalExecutorDispatchOperatorCanExecute: capitalLocalExecutorDispatch.operatorCanExecute,
    capitalLocalExecutorDispatchExecutorArmed: capitalLocalExecutorDispatch.executorArmed,
    capitalLocalExecutorDispatchNoOrderWrite: capitalLocalExecutorDispatch.noOrderWrite,
    capitalLocalExecutorDispatchSentOrder: capitalLocalExecutorDispatch.sentOrder,
    capitalTradeAutoCycle,
    capitalTradeAutoCycleMachineLine: capitalTradeAutoCycle.machineLine,
    capitalTradeAutoCyclePublishMachineLine: capitalTradeAutoCycle.publishMachineLine,
    capitalTradeAutoCycleOperatorCanExecute: capitalTradeAutoCycle.operatorCanExecute,
    capitalTradeAutoCycleNoLiveOrderSent: capitalTradeAutoCycle.noLiveOrderSent,
    capitalTradeAutoCycleSentOrder: capitalTradeAutoCycle.sentOrder,
    capitalTailRiskRepairMachineLine:
      normalizeTextValue(capitalTailRiskRepairClosure?.machineLine) ?? "unavailable",
    capitalTailRiskNextCommand:
      normalizeTextValue(capitalTailRiskRepairClosure?.nextCommand) ?? "unavailable",
    capitalTailRiskNextCommandMachineLine,
    capitalFailedReplayHistoryMachineLine,
    capitalFailedReplayHistoryNoOrderWrite:
      capitalTailRiskRepairClosure?.noOrderWrite === true ||
      capitalFailedReplayHistoryMachineLine.includes("noOrderWrite=true"),
    capitalRiskResizedRejection: capitalRiskResizedRejectionClosure,
    capitalRiskResizedRejectionMachineLine,
    capitalRiskResizedRejectionPublishMachineLine,
    capitalRiskResizedRejectionNoOrderWrite:
      capitalRiskResizedRejectionClosure?.noOrderWrite === true ||
      capitalRiskResizedRejectionMachineLine.includes("noOrderWrite=true"),
    capitalRiskResizedRejectionSentOrder:
      capitalRiskResizedRejectionClosure?.sentOrder === true ||
      capitalRiskResizedRejectionMachineLine.includes("sentOrder=true"),
    reportPath: `${STATE_DIR_REL}/${TELEGRAM_TRADING_SHORTCUTS_REPORT_NAME}`,
  };
}

function buildTradingAgentsStatus(tradingAgentsReport) {
  const runtime =
    tradingAgentsReport?.runtime &&
    typeof tradingAgentsReport.runtime === "object" &&
    !Array.isArray(tradingAgentsReport.runtime)
      ? tradingAgentsReport.runtime
      : {};
  const status = normalizeTextValue(tradingAgentsReport?.status) ?? "missing";
  const provider = normalizeTextValue(runtime.provider) ?? "unknown";
  const mode = normalizeTextValue(runtime.mode) ?? "unknown";
  const canAnalyze = tradingAgentsReport?.canAnalyzeNow === true;
  const official = tradingAgentsReport?.canUseOfficialTradingAgents === true;
  const noOrderWriteVerified = runtime.noOrderWrite === true;
  const noLiveOrderSent = tradingAgentsReport?.no_live_order_sent === true;
  const brokerWriteAttempted =
    tradingAgentsReport?.brokerWriteAttempted === true || runtime.brokerWriteAttempted === true;
  const nextSafeTask =
    normalizeTextValue(tradingAgentsReport?.nextSafeTask) ??
    "run pnpm tradingagents:install only after explicit human approval";
  return {
    exists: tradingAgentsReport !== null && typeof tradingAgentsReport === "object",
    status,
    provider,
    mode,
    canAnalyze,
    official,
    noOrderWriteVerified,
    noLiveOrderSent,
    brokerWriteAttempted,
    nextSafeTask,
    machineLine: [
      `tradingAgents=${status}`,
      `provider=${provider}`,
      `mode=${mode}`,
      `canAnalyze=${String(canAnalyze)}`,
      `official=${String(official)}`,
      `noOrderWriteVerified=${String(noOrderWriteVerified)}`,
      `noLiveOrderSent=${String(noLiveOrderSent)}`,
      `brokerWriteAttempted=${String(brokerWriteAttempted)}`,
    ].join(" "),
    reportPath: `${STATE_DIR_REL}/${TRADINGAGENTS_SUMMARY_REPORT_NAME}`,
  };
}

function buildOkxCurrentReadinessHeartbeatOperationStatus(closure) {
  const machineLine =
    normalizeTextValue(closure?.machineLine) ??
    `okxCurrentReadinessHeartbeat=missing noOrderWrite=${String(closure?.noOrderWrite === true)}`;
  const callbackPair = Array.isArray(closure?.callbackPair) ? closure.callbackPair : [];
  const telegramCallback =
    normalizeTextValue(closure?.telegramCallback) ??
    normalizeTextValue(callbackPair[0]) ??
    "sc:tr:okxrefresh";
  const refreshCommand =
    normalizeTextValue(closure?.refreshCommand) ?? "pnpm okx:current-readiness:refresh";
  const executeRequired = closure?.executeRequired === true;
  const noOrderWrite = closure?.noOrderWrite === true || machineLine.includes("noOrderWrite=true");
  const schedulerNextRunAt =
    normalizeTextValue(closure?.schedulerNextRunAt) ??
    machineLine.match(/\bschedulerNextRunAt=([^\s｜|]+)/u)?.[1] ??
    "unavailable";
  const refreshMachineLine = [
    `okxHeartbeatRefresh=${telegramCallback}`,
    `command=${refreshCommand}`,
    `schedulerNextRunAt=${schedulerNextRunAt}`,
    `executeRequired=${String(executeRequired)}`,
    `noOrderWrite=${String(noOrderWrite)}`,
  ].join(" ");
  return {
    exists: closure !== null && typeof closure === "object",
    status: normalizeTextValue(closure?.status) ?? "missing",
    machineLine,
    telegramCallback,
    refreshCommand,
    schedulerNextRunAt,
    executeRequired,
    noOrderWrite,
    refreshMachineLine,
    reportPath:
      normalizeTextValue(closure?.reportPath) ??
      "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
  };
}

function buildOkxCurrentReadinessRefreshWorkflowStatus(closure) {
  const failedSteps = Array.isArray(closure?.failedSteps)
    ? closure.failedSteps.filter((step) => typeof step === "string" && step.trim().length > 0)
    : [];
  const machineLine =
    normalizeTextValue(closure?.machineLine) ??
    `okxCurrentReadinessRefresh=missing steps=0/0 noOrderWrite=${String(closure?.noOrderWrite === true)}`;
  return {
    exists: closure !== null && typeof closure === "object",
    status: normalizeTextValue(closure?.status) ?? "missing",
    code: normalizeTextValue(closure?.code) ?? "missing",
    machineLine,
    totalSteps: numericOrNull(closure?.totalSteps),
    passedSteps: numericOrNull(closure?.passedSteps),
    failedSteps,
    latestRefreshRunStatus: normalizeTextValue(closure?.latestRefreshRunStatus) ?? "unavailable",
    latestRefreshRunExitCode:
      closure?.latestRefreshRunExitCode === null || closure?.latestRefreshRunExitCode === "null"
        ? "null"
        : (normalizeTextValue(closure?.latestRefreshRunExitCode) ?? "unavailable"),
    reportRead: closure?.reportRead === true,
    assistantStatusStripVisible: closure?.assistantStatusStripVisible === true,
    noOrderWrite: closure?.noOrderWrite === true,
    reportPath:
      normalizeTextValue(closure?.reportPath) ??
      "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
  };
}

function buildTradingReadinessStatus({
  quickQuoteStatus,
  paperOrderModeStatus,
  capitalServiceStatus,
  okxRefreshWorkflowStatus,
  tradingShortcutsStatus,
}) {
  const okxMachineLine = normalizeTextValue(okxRefreshWorkflowStatus?.machineLine) ?? "";
  const okxWorkflowStatus =
    okxMachineLine.match(/\bokxCurrentReadinessRefresh=([^\s｜|]+)/u)?.[1] ??
    normalizeTextValue(okxRefreshWorkflowStatus?.status) ??
    "missing";
  const okxFreshness =
    okxMachineLine.match(/\bfreshness=([^\s｜|]+)/u)?.[1] ??
    normalizeTextValue(okxRefreshWorkflowStatus?.latestRefreshRunStatus) ??
    "unknown";
  const okxQuoteStatus = `${okxWorkflowStatus}:${okxFreshness}`;
  const operatorPacket = tradingShortcutsStatus?.capitalOperatorPacket ?? null;
  const packetStatus = normalizeTextValue(operatorPacket?.packetStatus) ?? "missing";
  const readinessStatus = normalizeTextValue(operatorPacket?.readinessStatus) ?? "unknown";
  const dispatchPolicy = normalizeTextValue(operatorPacket?.dispatchPolicy) ?? "unknown";
  const serviceReplyLine =
    typeof capitalServiceStatus?.replyLine === "string" ? capitalServiceStatus.replyLine : "";
  const serviceSimulationStatus = serviceReplyLine.match(/模擬=([^｜|]+)/u)?.[1]?.trim() ?? "";
  const sentState =
    operatorPacket?.sentOrder === true
      ? "sent"
      : operatorPacket?.sentOrder === false
        ? "not_sent"
        : "sent_unknown";
  const simulationStatus =
    capitalServiceStatus?.exists === true && serviceSimulationStatus.length > 0
      ? `service:${serviceSimulationStatus}`
      : `paper:${packetStatus}/${readinessStatus}/${dispatchPolicy}/${sentState}`;
  const simulationStatusZhTw =
    capitalServiceStatus?.exists === true && serviceSimulationStatus.length > 0
      ? `服務:${serviceSimulationStatus}`
      : `紙上:${packetStatus}/${readinessStatus}/${dispatchPolicy}/${sentState}`;
  const quoteStatus = `capital=${quickQuoteStatus},okx=${okxQuoteStatus}`;
  return {
    quoteStatus,
    simulationStatus,
    orderModeStatus: paperOrderModeStatus,
    machineLine: `tradingReadiness=quote:${quoteStatus};simulation=${simulationStatus};orderMode=${paperOrderModeStatus}`,
    zhTw: `交易就緒=報價:群益=${quickQuoteStatus},OKX=${okxQuoteStatus}；模擬:${simulationStatusZhTw}；下單模式:${paperOrderModeStatus}`,
  };
}

export function buildTelegramSummary(report, options = {}) {
  const rawBlockers = Array.isArray(report.remaining_blockers) ? report.remaining_blockers : [];
  const hasBlockers = rawBlockers.length > 0;
  const blockers = hasBlockers ? rawBlockers : ["none"];
  const nextSafeTaskId = normalizeTextValue(report.next_safe_task?.id) ?? "待刷新";
  const nextSafeCommand = normalizeTextValue(report.next_safe_task?.command) ?? "待刷新";
  const nextSafeResolverCandidateId =
    normalizeTextValue(report.next_safe_task?.resolver_candidate_id) ?? "none";
  const nextSafeResolverCandidateReportPath =
    normalizeTextValue(report.next_safe_task?.resolver_candidate_report_path) ?? "none";
  const taskId = normalizeTextValue(report.task?.id) ?? "待刷新";
  const taskLabel = normalizeTextValue(report.task?.label) ?? "待刷新";
  const taskFullCommand = normalizeTextValue(report.task?.fullCommand) ?? "待刷新";
  const taskExitCode = report.task?.exitCode;
  const taskPassed = typeof taskExitCode === "number" ? taskExitCode === 0 : null;
  const overallStatusText =
    report.core_result !== "success" ? "FAILED" : hasBlockers ? "BLOCKED" : "SUCCESS";
  const overallStatusZhTw =
    report.core_result !== "success" ? "失敗" : hasBlockers ? "阻塞中" : "成功";
  const taskStatusText = taskPassed === null ? "UNKNOWN" : taskPassed ? "TASK_OK" : "TASK_FAIL";
  const taskStatusZhTw = taskPassed === null ? "未知" : taskPassed ? "任務通過" : "任務失敗";
  const taskText = `${taskId} (exit=${String(taskExitCode ?? "unknown")})`;
  const blockersText = blockers.join(", ");
  const quickQuote = report.validation_result?.capital_quick_quote_latest ?? null;
  const capitalServiceStatus = report.validation_result?.capital_service_status ?? null;
  const serviceStatusAuthoritativeReady =
    isCapitalServiceStatusAuthoritativeReady(capitalServiceStatus);
  const quickQuoteStatus = quickQuote?.coveredByFreshQuoteGate
    ? "covered_by_fresh_quote_gate"
    : quickQuote?.coveredByServiceStatus
      ? "covered_by_service_status"
      : quickQuote
        ? `${quickQuote.symbol ?? "?"}:${quickQuote.status ?? "unknown"}/${quickQuote.selectedReason ?? quickQuote.reason ?? "unknown"}`
        : "unavailable";
  const capitalPaperAssistantState =
    report.validation_result?.capital_paper_assistant_state ?? null;
  const capitalLiveTradingApprovalSummary =
    report.validation_result?.capital_live_trading_approval_summary ?? null;
  const capitalLiveTradingApprovalTelegramPublish =
    report.validation_result?.capital_live_trading_approval_telegram_publish ?? null;
  const capitalLiveTradingOperatorAutoDeactivate =
    report.validation_result?.capital_live_trading_operator_auto_deactivate ?? null;
  const capitalLiveTradingOperatorAutoDeactivateReceiptGate =
    report.validation_result?.capital_live_trading_operator_auto_deactivate_receipt_gate ?? null;
  const liveOrderStatus = formatCapitalLiveApprovalStatus(
    capitalLiveTradingApprovalSummary,
    capitalPaperAssistantState,
  );
  const liveApprovalTelegramStatus = formatCapitalLiveApprovalTelegramPublishStatus(
    capitalLiveTradingApprovalTelegramPublish,
  );
  const liveAutoDeactivateStatus = formatCapitalLiveTradingOperatorAutoDeactivateStatus(
    capitalLiveTradingOperatorAutoDeactivate,
  );
  const liveAutoDeactivateReceiptStatus =
    formatCapitalLiveTradingOperatorAutoDeactivateReceiptGateStatus(
      capitalLiveTradingOperatorAutoDeactivateReceiptGate,
    );
  const liveAutoDeactivateReceiptPrompt =
    buildCapitalLiveTradingOperatorAutoDeactivateReceiptPrompt(
      capitalLiveTradingOperatorAutoDeactivateReceiptGate,
      nextSafeCommand,
    );
  const paperOrderModeStatus = formatPaperOrderModeStatus(
    capitalPaperAssistantState,
    capitalServiceStatus,
  );
  const capitalTelegramOwnerCheck = report.validation_result?.capital_telegram_owner_check ?? null;
  const telegramOwnerStatus = formatCapitalTelegramOwnerStatus(capitalTelegramOwnerCheck);
  const capitalOverseasStaleRecovery =
    report.validation_result?.capital_overseas_stale_recovery ?? null;
  const overseasStaleRecoveryStatus = formatCapitalOverseasStaleRecoveryStatus(
    capitalOverseasStaleRecovery,
  );
  const coreProductMatrix = report.validation_result?.capital_core_product_freshness_matrix ?? null;
  const coreProductMatrixStatus = serviceStatusAuthoritativeReady
    ? `READY_BY_SERVICE_STATUS:${capitalServiceStatus.matrixSummary?.freshCount ?? "?"}/${capitalServiceStatus.matrixSummary?.productCount ?? "?"}`
    : formatCapitalCoreProductMatrixStatus(coreProductMatrix);
  const tradingShortcutsStatus = buildTelegramTradingShortcutsStatus(
    options.tradingShortcutsReport ?? null,
  );
  const tradingAgentsStatus = buildTradingAgentsStatus(options.tradingAgentsReport ?? null);
  const okxHeartbeatPublishTokenCounts = buildOkxHeartbeatPublishTokenCountsStatus(
    options.telegramPublishReport ?? null,
  );
  const okxRefreshWorkflowStatus = tradingShortcutsStatus.okxCurrentReadinessRefreshWorkflow;
  const tradingReadinessStatus = buildTradingReadinessStatus({
    quickQuoteStatus,
    paperOrderModeStatus,
    capitalServiceStatus,
    okxRefreshWorkflowStatus,
    tradingShortcutsStatus,
  });
  const dmadValidationHint = buildDmadValidationHint();
  const dmadPublishStatus =
    report.dmad_publish_status &&
    typeof report.dmad_publish_status === "object" &&
    !Array.isArray(report.dmad_publish_status)
      ? report.dmad_publish_status
      : buildDmadPublishStatus(report.validation_result?.telegram_publish ?? null);
  const oneLine = `[OpenClaw] ${overallStatusText} | lane=${report.lane} | task=${taskText} | taskStatus=${taskStatusText} | blockers=${blockersText} | ${tradingReadinessStatus.machineLine} | quickQuote=${quickQuoteStatus} | telegramOwner=${telegramOwnerStatus} | coreMatrix=${coreProductMatrixStatus} | overseasRecovery=${overseasStaleRecoveryStatus} | liveOrder=${liveOrderStatus} | liveApprovalTelegram=${liveApprovalTelegramStatus} | liveAutoDeactivate=${liveAutoDeactivateStatus} | liveAutoDeactivateReceipt=${liveAutoDeactivateReceiptStatus} | ${liveAutoDeactivateReceiptPrompt.machineLine} | orderMode=${paperOrderModeStatus} | tradingAgents=${tradingAgentsStatus.machineLine} | tradingShortcuts=${tradingShortcutsStatus.machineLine} | operatorPacket=${tradingShortcutsStatus.capitalOperatorPacketPublishMachineLine} | localExecutor=${tradingShortcutsStatus.capitalLocalExecutorDispatchPublishMachineLine} | autoCycle=${tradingShortcutsStatus.capitalTradeAutoCyclePublishMachineLine} | tailRiskNext=${tradingShortcutsStatus.capitalTailRiskNextCommandMachineLine} | riskResizedReject=${tradingShortcutsStatus.capitalRiskResizedRejectionPublishMachineLine} | okxRefresh=${okxRefreshWorkflowStatus.machineLine} | okxHeartbeat=${tradingShortcutsStatus.okxHeartbeatRefreshMachineLine} | okxHeartbeatTokenCounts=${okxHeartbeatPublishTokenCounts.machineLine} | shortcutNext=${tradingShortcutsStatus.nextCommandMachineLine} | dmadGate=${dmadValidationHint.gate} | ${dmadPublishStatus.machineLine} | next=${nextSafeTaskId} | resolver=${nextSafeResolverCandidateId}`;
  const oneLineZhTw = `[OpenClaw] ${overallStatusZhTw}｜車道=${report.lane}｜任務=${taskText}｜任務狀態=${taskStatusZhTw}｜阻塞=${blockersText}｜${tradingReadinessStatus.zhTw}｜快速報價=${quickQuoteStatus}｜Telegram入口=${telegramOwnerStatus}｜核心商品=${coreProductMatrixStatus}｜海外修復=${overseasStaleRecoveryStatus}｜真單=${liveOrderStatus}｜真單回報=${liveApprovalTelegramStatus}｜自動回關=${liveAutoDeactivateStatus}｜回關收據=${liveAutoDeactivateReceiptStatus}｜回關收據命令=${liveAutoDeactivateReceiptPrompt.machineLine}｜下單模式=${paperOrderModeStatus}｜TradingAgents=${tradingAgentsStatus.machineLine}｜快捷檢查=${tradingShortcutsStatus.machineLine}｜真單Packet=${tradingShortcutsStatus.capitalOperatorPacketPublishMachineLine}｜本地執行器=${tradingShortcutsStatus.capitalLocalExecutorDispatchPublishMachineLine}｜交易總循環=${tradingShortcutsStatus.capitalTradeAutoCyclePublishMachineLine}｜尾風險下一步=${tradingShortcutsStatus.capitalTailRiskNextCommandMachineLine}｜縮風險淘汰=${tradingShortcutsStatus.capitalRiskResizedRejectionPublishMachineLine}｜OKX刷新=${okxRefreshWorkflowStatus.machineLine}｜OKX心跳=${tradingShortcutsStatus.okxHeartbeatRefreshMachineLine}｜OKX心跳計數=${okxHeartbeatPublishTokenCounts.machineLine}｜下一步指令=${tradingShortcutsStatus.nextCommandMachineLine}｜DMAD=${dmadValidationHint.gate}｜DMAD發布=${dmadPublishStatus.machineLine}｜下一步=${nextSafeTaskId}｜resolver=${nextSafeResolverCandidateId}`;

  return {
    schema: TELEGRAM_SUMMARY_SCHEMA,
    generatedAt: report.generatedAt,
    lane: report.lane,
    readOnlyMode: report.readOnlyMode === true,
    core_result: report.core_result,
    task: {
      id: taskId,
      label: taskLabel,
      fullCommand: taskFullCommand,
      exitCode: report.task?.exitCode ?? null,
      durationMs: report.task?.durationMs ?? null,
    },
    blockers,
    next_safe_task: {
      id: nextSafeTaskId,
      command: nextSafeCommand,
      reason: normalizeTextValue(report.next_safe_task?.reason) ?? "待刷新",
      resolver_candidate_id: nextSafeResolverCandidateId,
      resolver_candidate_report_path: nextSafeResolverCandidateReportPath,
      resolver_candidate: report.next_safe_task?.resolver_candidate ?? null,
    },
    quick_quote_status: quickQuoteStatus,
    paper_order_mode_status: paperOrderModeStatus,
    trading_readiness_status: tradingReadinessStatus,
    trading_readiness_status_zh_tw: tradingReadinessStatus.zhTw,
    live_approval_telegram_status: liveApprovalTelegramStatus,
    live_auto_deactivate_status: liveAutoDeactivateStatus,
    live_auto_deactivate_receipt_status: liveAutoDeactivateReceiptStatus,
    live_auto_deactivate_receipt_prompt: liveAutoDeactivateReceiptPrompt,
    telegram_owner_status: telegramOwnerStatus,
    core_product_freshness_matrix_status: coreProductMatrixStatus,
    overseas_stale_recovery_status: overseasStaleRecoveryStatus,
    capital_quick_quote_latest: quickQuote,
    capital_service_status: capitalServiceStatus,
    capital_telegram_owner_check: capitalTelegramOwnerCheck,
    capital_overseas_stale_recovery: capitalOverseasStaleRecovery,
    capital_core_product_freshness_matrix: coreProductMatrix,
    capital_paper_assistant_state: capitalPaperAssistantState,
    capital_live_trading_approval_summary: capitalLiveTradingApprovalSummary,
    capital_live_trading_approval_telegram_publish: capitalLiveTradingApprovalTelegramPublish,
    capital_live_trading_operator_auto_deactivate: capitalLiveTradingOperatorAutoDeactivate,
    capital_live_trading_operator_auto_deactivate_receipt_gate:
      capitalLiveTradingOperatorAutoDeactivateReceiptGate,
    trading_agents: tradingAgentsStatus,
    telegram_trading_shortcuts: tradingShortcutsStatus,
    capital_operator_packet: tradingShortcutsStatus.capitalOperatorPacket,
    capital_local_executor_dispatch: tradingShortcutsStatus.capitalLocalExecutorDispatch,
    capital_trade_auto_cycle: tradingShortcutsStatus.capitalTradeAutoCycle,
    okx_current_readiness_refresh_workflow: okxRefreshWorkflowStatus,
    okx_heartbeat_publish_token_counts: okxHeartbeatPublishTokenCounts,
    dmad_validation_hint: dmadValidationHint,
    dmad_publish_status: dmadPublishStatus,
    risk: report.risk,
    telegram_summary_oneline: oneLine,
    telegram_summary_oneline_zh_tw: oneLineZhTw,
  };
}

function renderTelegramSummaryMarkdown(summary) {
  return [
    "# OpenClaw Controlled Runner Telegram Summary",
    "",
    `- generated_at: ${summary.generatedAt}`,
    `- lane: ${summary.lane}`,
    `- core_result: ${summary.core_result}`,
    `- read_only_mode: ${String(summary.readOnlyMode)}`,
    `- task: ${summary.task.id} (${summary.task.fullCommand})`,
    `- exit_code: ${String(summary.task.exitCode ?? "unknown")}`,
    `- duration_ms: ${String(summary.task.durationMs ?? "unknown")}`,
    `- blockers: ${summary.blockers.join(", ")}`,
    `- quick_quote: ${summary.quick_quote_status}`,
    `- trading_readiness_status: ${summary.trading_readiness_status.machineLine}`,
    `- telegram_owner: ${summary.telegram_owner_status}`,
    `- core_products: ${summary.core_product_freshness_matrix_status}`,
    `- overseas_stale_recovery: ${summary.overseas_stale_recovery_status}`,
    `- live_order: ${formatCapitalLiveApprovalStatus(summary.capital_live_trading_approval_summary, summary.capital_paper_assistant_state)}`,
    `- live_approval_telegram: ${summary.live_approval_telegram_status}`,
    `- live_auto_deactivate: ${summary.live_auto_deactivate_status}`,
    `- live_auto_deactivate_receipt: ${summary.live_auto_deactivate_receipt_status}`,
    `- live_auto_deactivate_receipt_prompt: ${summary.live_auto_deactivate_receipt_prompt.machineLine}`,
    `- live_auto_deactivate_receipt_command: ${summary.live_auto_deactivate_receipt_prompt.command}`,
    `- order_mode: ${summary.paper_order_mode_status}`,
    `- trading_agents: ${summary.trading_agents.machineLine}`,
    `- trading_agents_no_order_write_verified: ${String(summary.trading_agents.noOrderWriteVerified)}`,
    `- trading_agents_no_live_order_sent: ${String(summary.trading_agents.noLiveOrderSent)}`,
    `- trading_shortcuts: ${summary.telegram_trading_shortcuts.machineLine}`,
    `- capital_operator_packet: ${summary.telegram_trading_shortcuts.capitalOperatorPacketPublishMachineLine}`,
    `- capital_operator_packet_machine_line: ${summary.telegram_trading_shortcuts.capitalOperatorPacketMachineLine}`,
    `- capital_operator_packet_can_execute: ${String(summary.telegram_trading_shortcuts.capitalOperatorPacketOperatorCanExecute)}`,
    `- capital_operator_packet_sent_order: ${String(summary.telegram_trading_shortcuts.capitalOperatorPacketSentOrder)}`,
    `- capital_operator_packet_adapter_apply_receipt_status: ${summary.telegram_trading_shortcuts.capitalOperatorPacketAdapterApplyReceiptStatus}`,
    `- capital_operator_packet_adapter_apply_receipt_verified: ${String(summary.telegram_trading_shortcuts.capitalOperatorPacketAdapterApplyReceiptVerified)}`,
    `- capital_operator_packet_adapter_apply_receipt_operator_may_apply: ${String(summary.telegram_trading_shortcuts.capitalOperatorPacketAdapterApplyReceiptOperatorMayApply)}`,
    `- capital_local_executor_dispatch: ${summary.telegram_trading_shortcuts.capitalLocalExecutorDispatchPublishMachineLine}`,
    `- capital_local_executor_dispatch_machine_line: ${summary.telegram_trading_shortcuts.capitalLocalExecutorDispatchMachineLine}`,
    `- capital_local_executor_dispatch_operator_can_execute: ${String(summary.telegram_trading_shortcuts.capitalLocalExecutorDispatchOperatorCanExecute)}`,
    `- capital_local_executor_dispatch_executor_armed: ${String(summary.telegram_trading_shortcuts.capitalLocalExecutorDispatchExecutorArmed)}`,
    `- capital_local_executor_dispatch_sent_order: ${String(summary.telegram_trading_shortcuts.capitalLocalExecutorDispatchSentOrder)}`,
    `- capital_trade_auto_cycle: ${summary.telegram_trading_shortcuts.capitalTradeAutoCyclePublishMachineLine}`,
    `- capital_trade_auto_cycle_machine_line: ${summary.telegram_trading_shortcuts.capitalTradeAutoCycleMachineLine}`,
    `- capital_trade_auto_cycle_no_live_order_sent: ${String(summary.telegram_trading_shortcuts.capitalTradeAutoCycleNoLiveOrderSent)}`,
    `- capital_trade_auto_cycle_sent_order: ${String(summary.telegram_trading_shortcuts.capitalTradeAutoCycleSentOrder)}`,
    `- capital_tail_risk_next_command: ${summary.telegram_trading_shortcuts.capitalTailRiskNextCommandMachineLine}`,
    `- capital_risk_resized_rejection: ${summary.telegram_trading_shortcuts.capitalRiskResizedRejectionMachineLine}`,
    `- capital_risk_resized_rejection_publish: ${summary.telegram_trading_shortcuts.capitalRiskResizedRejectionPublishMachineLine}`,
    `- capital_failed_replay_history: ${summary.telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine}`,
    `- capital_failed_replay_history_no_order_write: ${String(summary.telegram_trading_shortcuts.capitalFailedReplayHistoryNoOrderWrite)}`,
    `- okx_refresh_workflow: ${summary.okx_current_readiness_refresh_workflow.machineLine}`,
    `- okx_refresh_no_order_write: ${String(summary.okx_current_readiness_refresh_workflow.noOrderWrite)}`,
    `- okx_heartbeat_refresh: ${summary.telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine}`,
    `- okx_heartbeat_scheduler_next_run_at: ${summary.telegram_trading_shortcuts.okxCurrentReadinessHeartbeatOperation.schedulerNextRunAt}`,
    `- okx_heartbeat_execute_required: ${String(summary.telegram_trading_shortcuts.okxHeartbeatExecuteRequired)}`,
    `- okx_heartbeat_no_order_write: ${String(summary.telegram_trading_shortcuts.okxHeartbeatNoOrderWrite)}`,
    `- okx_heartbeat_publish_token_counts: ${summary.okx_heartbeat_publish_token_counts.machineLine}`,
    `- okx_heartbeat_publish_no_order_write_count: ${String(summary.okx_heartbeat_publish_token_counts.noOrderWriteCount ?? "unknown")}`,
    `- trading_next_command: ${summary.telegram_trading_shortcuts.nextCommandMachineLine}`,
    `- dmad_validation_gate: ${summary.dmad_validation_hint.machineLine}`,
    `- dmad_validation_command: ${summary.dmad_validation_hint.command}`,
    `- dmad_publish_status: ${summary.dmad_publish_status.machineLine}`,
    `- next_safe_task: ${summary.next_safe_task.id}`,
    `- next_safe_command: ${summary.next_safe_task.command}`,
    `- resolver_candidate: ${summary.next_safe_task.resolver_candidate_id}`,
    `- resolver_candidate_report: ${summary.next_safe_task.resolver_candidate_report_path}`,
    `- risk: ${summary.risk}`,
    "",
    "## Telegram One-Line",
    "",
    `- en: ${summary.telegram_summary_oneline}`,
    `- zh-TW: ${summary.telegram_summary_oneline_zh_tw}`,
    "",
  ].join("\n");
}

async function writeTelegramSummary(repoRoot, report) {
  const stateDir = path.join(repoRoot, STATE_DIR_REL);
  await fs.mkdir(stateDir, { recursive: true });

  const tradingShortcutsReport = await readJson(
    path.join(stateDir, TELEGRAM_TRADING_SHORTCUTS_REPORT_NAME),
  );
  const tradingAgentsReport = await readJson(
    path.join(stateDir, TRADINGAGENTS_SUMMARY_REPORT_NAME),
  );
  const telegramPublishReport = await readJson(path.join(stateDir, TELEGRAM_PUBLISH_REPORT_NAME));
  const summary = buildTelegramSummary(report, {
    tradingShortcutsReport,
    telegramPublishReport,
    tradingAgentsReport,
  });
  const jsonPath = path.join(stateDir, LATEST_TELEGRAM_JSON_NAME);
  const mdPath = path.join(stateDir, LATEST_TELEGRAM_MD_NAME);

  await writeJson(jsonPath, summary);
  await fs.writeFile(mdPath, renderTelegramSummaryMarkdown(summary), "utf8");

  return {
    telegramJsonPath: toPosix(path.relative(repoRoot, jsonPath)),
    telegramMarkdownPath: toPosix(path.relative(repoRoot, mdPath)),
  };
}

function buildTelegramPublishStatusReport(params) {
  const upstreamMessageTokenCounts =
    params.upstreamMessageTokenCounts !== null &&
    typeof params.upstreamMessageTokenCounts === "object"
      ? params.upstreamMessageTokenCounts
      : null;
  const upstreamMessageTokenCountsSummaryZhTw =
    typeof params.upstreamMessageTokenCountsSummaryZhTw === "string"
      ? params.upstreamMessageTokenCountsSummaryZhTw
      : null;
  const upstreamSchedulerNextRunAt =
    normalizeTextValue(params.upstreamSchedulerNextRunAt) ??
    extractSchedulerNextRunAt(params.reason);
  const upstreamNoOrderWriteCount = numericOrNull(upstreamMessageTokenCounts?.noOrderWrite);
  const upstreamPositionSnapshotCount = numericOrNull(upstreamMessageTokenCounts?.positionSnapshot);
  const upstreamExecuteRequiredCount = numericOrNull(upstreamMessageTokenCounts?.executeRequired);
  const upstreamOkxContractCount = numericOrNull(upstreamMessageTokenCounts?.okxContract);
  const upstreamDmadGateCount = numericOrNull(upstreamMessageTokenCounts?.dmadGate);
  return {
    schema: "openclaw.controlled-task-runner.telegram-publish-bridge-status.v1",
    generatedAt: new Date().toISOString(),
    status: params.status,
    errorCode: typeof params.errorCode === "string" ? params.errorCode : "BRIDGE_UNKNOWN_STATUS",
    reason: params.reason ?? null,
    target:
      typeof params.target === "string" && params.target.trim().length > 0 ? params.target : null,
    targetSource:
      typeof params.targetSource === "string" && params.targetSource.trim().length > 0
        ? params.targetSource
        : null,
    targetSourcePath:
      typeof params.targetSourcePath === "string" && params.targetSourcePath.trim().length > 0
        ? params.targetSourcePath
        : null,
    dryRun: typeof params.dryRun === "boolean" ? params.dryRun : true,
    publishMode:
      typeof params.publishMode === "string" && params.publishMode.trim().length > 0
        ? params.publishMode
        : "dry-run",
    commandExitCode: params.exitCode ?? null,
    commandDurationMs: params.durationMs ?? null,
    bridgeScript: TELEGRAM_PUBLISH_SCRIPT_REL,
    targetEnv: TELEGRAM_PUBLISH_TARGET_ENV,
    enableEnv: TELEGRAM_PUBLISH_ENABLE_ENV,
    modeEnv: TELEGRAM_PUBLISH_MODE_ENV,
    upstreamSchema: params.upstreamSchema ?? null,
    upstreamStatus: params.upstreamStatus ?? null,
    upstreamErrorCode:
      typeof params.upstreamErrorCode === "string" ? params.upstreamErrorCode : null,
    upstreamDryRun: typeof params.upstreamDryRun === "boolean" ? params.upstreamDryRun : null,
    upstreamCommandExitCode:
      typeof params.upstreamCommandExitCode === "number" ? params.upstreamCommandExitCode : null,
    upstreamCommandAttemptsUsed:
      typeof params.upstreamCommandAttemptsUsed === "number"
        ? params.upstreamCommandAttemptsUsed
        : null,
    upstreamCommandMaxAttempts:
      typeof params.upstreamCommandMaxAttempts === "number"
        ? params.upstreamCommandMaxAttempts
        : null,
    upstreamCommandRetryBaseDelayMs:
      typeof params.upstreamCommandRetryBaseDelayMs === "number"
        ? params.upstreamCommandRetryBaseDelayMs
        : null,
    upstreamNextSafeTask:
      typeof params.upstreamNextSafeTask === "string" ? params.upstreamNextSafeTask : null,
    upstreamMessageTokenCounts,
    upstreamMessageTokenCountsSummaryZhTw,
    upstreamSchedulerNextRunAt,
    upstreamNoOrderWriteCount,
    upstreamPositionSnapshotCount,
    upstreamExecuteRequiredCount,
    upstreamOkxContractCount,
    upstreamDmadGateCount,
    upstreamNoOrderWriteVerified:
      upstreamNoOrderWriteCount === 4 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("noOrderWrite=true=4") === true,
    upstreamPositionSnapshotVerified:
      upstreamPositionSnapshotCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("倉位快照=1") === true,
    upstreamOkxContractVerified:
      upstreamOkxContractCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("OKX合約=1") === true,
    upstreamDmadGateVerified:
      upstreamDmadGateCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("DMAD=1") === true,
  };
}

function classifyTelegramPublishBridgeErrorCode(status) {
  switch (status) {
    case "dry_run_ok":
    case "publish_ok":
      return "OK";
    case "skipped_disabled":
      return "BRIDGE_DISABLED";
    case "skipped_missing_target":
      return "BRIDGE_MISSING_TARGET";
    case "blocked_missing_publish_script":
      return "BRIDGE_SCRIPT_MISSING";
    case "publish_failed":
      return "BRIDGE_UPSTREAM_FAILED";
    default:
      return "BRIDGE_UNKNOWN_STATUS";
  }
}

async function runTelegramPublishBridge(repoRoot) {
  const isEnabled = (process.env[TELEGRAM_PUBLISH_ENABLE_ENV] ?? "1") !== "0";
  const requestedMode = (process.env[TELEGRAM_PUBLISH_MODE_ENV] ?? "dry-run").trim().toLowerCase();
  const publishMode = requestedMode === "execute" ? "execute" : "dry-run";
  const dryRun = publishMode !== "execute";
  const publishReportPath = path.join(repoRoot, STATE_DIR_REL, TELEGRAM_PUBLISH_REPORT_NAME);
  const bridgeReportPath = path.join(repoRoot, STATE_DIR_REL, TELEGRAM_PUBLISH_BRIDGE_REPORT_NAME);
  const bridgeReportPathRel = toPosix(path.relative(repoRoot, bridgeReportPath));
  await fs.mkdir(path.dirname(bridgeReportPath), { recursive: true });

  if (!isEnabled) {
    await writeJson(
      bridgeReportPath,
      buildTelegramPublishStatusReport({
        status: "skipped_disabled",
        errorCode: classifyTelegramPublishBridgeErrorCode("skipped_disabled"),
        reason: `${TELEGRAM_PUBLISH_ENABLE_ENV}=0`,
        dryRun,
        publishMode,
      }),
    );
    return {
      status: "skipped_disabled",
      exitCode: null,
      durationMs: 0,
      reportPath: bridgeReportPathRel,
      reason: `${TELEGRAM_PUBLISH_ENABLE_ENV}=0`,
    };
  }

  const targetResolution = await resolveTelegramPublishTarget(repoRoot);
  const target = targetResolution.target;
  if (!target) {
    await writeJson(
      bridgeReportPath,
      buildTelegramPublishStatusReport({
        status: "skipped_missing_target",
        errorCode: classifyTelegramPublishBridgeErrorCode("skipped_missing_target"),
        reason: `${TELEGRAM_PUBLISH_TARGET_ENV} not set and no fallback target in ${targetResolution.sourcePath ?? TELEGRAM_SENT_MESSAGES_REL}`,
        targetSource: targetResolution.source,
        targetSourcePath: targetResolution.sourcePath,
        dryRun,
        publishMode,
      }),
    );
    return {
      status: "skipped_missing_target",
      exitCode: null,
      durationMs: 0,
      reportPath: bridgeReportPathRel,
      reason: `${TELEGRAM_PUBLISH_TARGET_ENV} not set and no fallback target in ${targetResolution.sourcePath ?? TELEGRAM_SENT_MESSAGES_REL}`,
    };
  }

  const publishScriptPath = path.join(repoRoot, TELEGRAM_PUBLISH_SCRIPT_REL);
  const scriptStats = await fs.stat(publishScriptPath).catch(() => null);
  if (!scriptStats || !scriptStats.isFile()) {
    await writeJson(
      bridgeReportPath,
      buildTelegramPublishStatusReport({
        status: "blocked_missing_publish_script",
        errorCode: classifyTelegramPublishBridgeErrorCode("blocked_missing_publish_script"),
        reason: `missing ${TELEGRAM_PUBLISH_SCRIPT_REL}`,
        exitCode: 1,
        dryRun,
        publishMode,
      }),
    );
    return {
      status: "blocked_missing_publish_script",
      exitCode: 1,
      durationMs: 0,
      reportPath: bridgeReportPathRel,
      reason: `missing ${TELEGRAM_PUBLISH_SCRIPT_REL}`,
    };
  }

  const summaryPath = path.join(repoRoot, STATE_DIR_REL, LATEST_TELEGRAM_JSON_NAME);
  const summary = await readJson(summaryPath);
  const message =
    typeof summary?.telegram_summary_oneline_zh_tw === "string"
      ? summary.telegram_summary_oneline_zh_tw.trim()
      : typeof summary?.telegram_summary_oneline === "string"
        ? summary.telegram_summary_oneline.trim()
        : "";
  if (!message) {
    throw new Error("Telegram summary missing telegram_summary_oneline field");
  }
  const threadId = (process.env.OPENCLAW_TELEGRAM_STATUS_THREAD_ID ?? "").trim();
  const publishArgs = [
    "message",
    "send",
    "--channel",
    "telegram",
    "--target",
    target,
    "--message",
    message,
  ];
  if (threadId) {
    publishArgs.push("--thread-id", threadId);
  }
  const publishModeArg = dryRun ? "--dry-run" : "--execute";
  const commandResult = await runCommand(process.execPath, [
    TELEGRAM_PUBLISH_SCRIPT_REL,
    publishModeArg,
  ]);
  const publishReport = await readJson(publishReportPath);
  const status =
    commandResult.exitCode !== 0
      ? "publish_failed"
      : typeof publishReport?.status === "string"
        ? publishReport.status
        : dryRun
          ? "dry_run_ok"
          : "publish_ok";
  const upstreamErrorCode =
    typeof publishReport?.errorCode === "string" ? publishReport.errorCode : null;
  const errorCode =
    status === "publish_failed"
      ? classifyTelegramPublishBridgeErrorCode(status)
      : (upstreamErrorCode ?? classifyTelegramPublishBridgeErrorCode(status));
  const reason =
    typeof publishReport?.message === "string" && publishReport.message.trim().length > 0
      ? publishReport.message.trim()
      : null;
  await writeJson(
    bridgeReportPath,
    buildTelegramPublishStatusReport({
      status,
      errorCode,
      reason,
      target,
      targetSource: targetResolution.source,
      targetSourcePath: targetResolution.sourcePath,
      dryRun,
      publishMode,
      exitCode: commandResult.exitCode,
      durationMs: commandResult.durationMs,
      upstreamSchema: publishReport?.schema,
      upstreamStatus: publishReport?.status,
      upstreamErrorCode,
      upstreamDryRun: publishReport?.dryRun,
      upstreamCommandExitCode: publishReport?.commandExitCode,
      upstreamCommandAttemptsUsed: publishReport?.commandAttemptsUsed,
      upstreamCommandMaxAttempts: publishReport?.commandMaxAttempts,
      upstreamCommandRetryBaseDelayMs: publishReport?.commandRetryBaseDelayMs,
      upstreamNextSafeTask: publishReport?.next_safe_task,
      upstreamMessageTokenCounts: publishReport?.messageTokenCounts,
      upstreamMessageTokenCountsSummaryZhTw: publishReport?.messageTokenCountsSummaryZhTw,
      upstreamSchedulerNextRunAt: extractSchedulerNextRunAt(publishReport?.message),
    }),
  );

  const upstreamNoOrderWriteCount = numericOrNull(publishReport?.messageTokenCounts?.noOrderWrite);
  const upstreamPositionSnapshotCount = numericOrNull(
    publishReport?.messageTokenCounts?.positionSnapshot,
  );
  const upstreamOkxContractCount = numericOrNull(publishReport?.messageTokenCounts?.okxContract);
  const upstreamDmadGateCount = numericOrNull(publishReport?.messageTokenCounts?.dmadGate);
  const upstreamMessageTokenCountsSummaryZhTw =
    typeof publishReport?.messageTokenCountsSummaryZhTw === "string"
      ? publishReport.messageTokenCountsSummaryZhTw
      : null;
  const upstreamSchedulerNextRunAt = extractSchedulerNextRunAt(publishReport?.message);
  return {
    status,
    exitCode: commandResult.exitCode,
    durationMs: commandResult.durationMs,
    reportPath: bridgeReportPathRel,
    reason,
    upstreamMessageTokenCounts: publishReport?.messageTokenCounts ?? null,
    upstreamMessageTokenCountsSummaryZhTw,
    upstreamSchedulerNextRunAt,
    upstreamNoOrderWriteCount,
    upstreamPositionSnapshotCount,
    upstreamOkxContractCount,
    upstreamDmadGateCount,
    upstreamNoOrderWriteVerified:
      upstreamNoOrderWriteCount === 4 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("noOrderWrite=true=4") === true,
    upstreamPositionSnapshotVerified:
      upstreamPositionSnapshotCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("倉位快照=1") === true,
    upstreamOkxContractVerified:
      upstreamOkxContractCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("OKX合約=1") === true,
    upstreamDmadGateVerified:
      upstreamDmadGateCount === 1 &&
      upstreamMessageTokenCountsSummaryZhTw?.includes("DMAD=1") === true,
  };
}

async function refreshCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
  repoRoot,
  selectedTask,
  commandResult,
) {
  const refreshCommand = "pnpm";
  const refreshArgs = ["capital:live-trading:operator:auto-deactivate:receipt"];
  const refreshCommandText = [refreshCommand, ...refreshArgs].join(" ");
  if (selectedTask.id !== "capital_live_trading_operator_auto_deactivate") {
    return null;
  }
  if (commandResult.exitCode !== 0) {
    return {
      status: "skipped_task_failed",
      command: refreshCommandText,
      exitCode: null,
      errorCode: "SKIPPED_TASK_FAILED",
      durationMs: 0,
      report: summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
        await loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate(repoRoot),
      ),
      workflowStep: {
        id: "post_task_receipt_gate_refresh",
        command: refreshCommandText,
        exitCode: null,
        errorCode: "SKIPPED_TASK_FAILED",
        status: "skipped",
      },
    };
  }

  const refreshResult = await runCommand(refreshCommand, refreshArgs);
  const report = summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
    await loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate(repoRoot),
  );
  return {
    status: refreshResult.exitCode === 0 ? "refreshed" : "refresh_failed",
    command: refreshCommandText,
    exitCode: refreshResult.exitCode,
    errorCode: refreshResult.errorCode ?? null,
    durationMs: refreshResult.durationMs,
    report,
    workflowStep: {
      id: "post_task_receipt_gate_refresh",
      command: refreshCommandText,
      exitCode: refreshResult.exitCode,
      errorCode: refreshResult.errorCode ?? null,
      status: refreshResult.exitCode === 0 ? "pass" : "fail",
    },
  };
}

async function runTask(repoRoot, selectedTask, selectionContext) {
  const startedAt = new Date().toISOString();
  const cardFrameworkPreflight = await runCardFrameworkPreflight(repoRoot);
  const taskRun = cardFrameworkPreflight.ok
    ? await runTaskCommandWithFallback(selectedTask)
    : {
        commandResult: buildCardFrameworkBlockedCommandResult(cardFrameworkPreflight),
        fallback: null,
      };
  const commandResult = taskRun.commandResult;
  const capitalLiveTradingOperatorAutoDeactivateReceiptRefresh = cardFrameworkPreflight.ok
    ? await refreshCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
        repoRoot,
        selectedTask,
        commandResult,
      )
    : null;
  const reportWorkflow = cardFrameworkPreflight.ok
    ? await buildReportWorkflow(
        selectedTask,
        commandResult,
        capitalLiveTradingOperatorAutoDeactivateReceiptRefresh?.workflowStep
          ? [capitalLiveTradingOperatorAutoDeactivateReceiptRefresh.workflowStep]
          : [],
      )
    : buildCardFrameworkBlockedReportWorkflow(selectedTask, commandResult, cardFrameworkPreflight);
  const finishedAt = new Date().toISOString();
  const quoteStatusPath = path.join(repoRoot, QUOTE_STATUS_REL);
  const serviceStatusPath = path.join(repoRoot, CAPITAL_SERVICE_STATUS_REL);
  const quoteStatus = await readJson(quoteStatusPath);
  const legacyQuoteBlockers = deriveQuoteBlockers(quoteStatus);
  const capitalServiceStatus = summarizeCapitalServiceStatus(await readJson(serviceStatusPath));
  const serviceStatusAuthoritativeReady =
    isCapitalServiceStatusAuthoritativeReady(capitalServiceStatus);
  const capitalServiceStatusBlockers = deriveCapitalServiceStatusBlockers(capitalServiceStatus);
  const capitalOverseasStaleRecovery = summarizeCapitalOverseasStaleRecovery(
    await loadCapitalOverseasStaleRecovery(repoRoot),
  );
  const capitalFreshQuoteGate = summarizeCapitalFreshQuoteGateLatest(
    await loadCapitalFreshQuoteGateLatest(),
  );
  const capitalDomesticQuoteComGuard = reconcileCapitalDomesticQuoteComGuard(
    summarizeCapitalDomesticQuoteComGuard(await loadCapitalDomesticQuoteComGuard()),
    { freshQuoteGate: capitalFreshQuoteGate, serviceStatus: capitalServiceStatus },
  );
  const capitalOverseasStaleRecoveryBlockers = deriveCapitalOverseasStaleRecoveryBlockers(
    capitalOverseasStaleRecovery,
    capitalServiceStatus,
  );
  const capitalDomesticQuoteComGuardBlockers = deriveCapitalDomesticQuoteComGuardBlockers(
    capitalDomesticQuoteComGuard,
    capitalFreshQuoteGate,
  );
  const quoteBlockers = capitalServiceStatus.exists
    ? [
        ...capitalServiceStatusBlockers,
        ...capitalOverseasStaleRecoveryBlockers,
        ...capitalDomesticQuoteComGuardBlockers,
      ]
    : [
        ...legacyQuoteBlockers,
        ...capitalServiceStatusBlockers,
        ...capitalOverseasStaleRecoveryBlockers,
        ...capitalDomesticQuoteComGuardBlockers,
      ];
  const capitalQuickQuote = reconcileCapitalQuickQuoteLatest(
    summarizeCapitalQuickQuoteLatest(await loadCapitalQuickQuoteLatest()),
    { serviceStatus: capitalServiceStatus, freshQuoteGate: capitalFreshQuoteGate },
  );
  const quoteStatusAuthoritativeReady =
    capitalFreshQuoteGate.ready === true ||
    isCapitalQuoteStatusAuthoritativeReady(capitalServiceStatus);
  const capitalQuickQuoteBlockers = quoteStatusAuthoritativeReady
    ? []
    : deriveCapitalQuickQuoteBlockers(capitalQuickQuote);
  const capitalTelegramOwnerCheck = summarizeCapitalTelegramOwnerCheck(
    await loadCapitalTelegramOwnerCheck(repoRoot),
  );
  const capitalPaperFillSimulation = summarizeCapitalPaperFillSimulation(
    await loadCapitalPaperFillSimulation(repoRoot),
  );
  const capitalPaperStrategyEvaluation = summarizeCapitalPaperStrategyEvaluation(
    await loadCapitalPaperStrategyEvaluation(repoRoot),
  );
  const capitalPaperAutoReview = summarizeCapitalPaperAutoReview(
    await loadCapitalPaperAutoReview(repoRoot),
  );
  const capitalPaperErrorRepair = summarizeCapitalPaperErrorRepair(
    await loadCapitalPaperErrorRepair(repoRoot),
  );
  const blackboxAutonomy = summarizeBlackboxAutonomyReport(
    await loadBlackboxAutonomyReport(repoRoot),
  );
  const blackboxSync = summarizeBlackboxSyncReport(await loadBlackboxSyncReport(repoRoot));
  const capitalStrategyFillSimulation = summarizeCapitalStrategyFillSimulation(
    await loadCapitalStrategyFillSimulation(repoRoot),
  );
  const hermesNuwaBridge = summarizeHermesNuwaBridgeReport(
    await loadHermesNuwaBridgeReport(repoRoot),
  );
  const capitalTelegramOwnerBlockers =
    deriveCapitalTelegramOwnerBlockers(capitalTelegramOwnerCheck);
  const capitalCoreProductMatrix = summarizeCapitalCoreProductFreshnessMatrix(
    await loadCapitalCoreProductFreshnessMatrix(repoRoot),
  );
  const capitalCoreProductMatrixBlockers = serviceStatusAuthoritativeReady
    ? []
    : deriveCapitalCoreProductMatrixBlockers(capitalCoreProductMatrix);
  const capitalPaperAssistantState = summarizeCapitalPaperAssistantState(
    await loadCapitalPaperAssistantState(repoRoot),
  );
  const capitalLiveTradingApprovalSummary = summarizeCapitalLiveTradingApprovalSummary(
    await loadCapitalLiveTradingApprovalSummary(repoRoot),
  );
  const capitalLiveTradingApprovalTelegramPublish =
    summarizeCapitalLiveTradingApprovalTelegramPublish(
      await loadCapitalLiveTradingApprovalTelegramPublish(repoRoot),
    );
  const capitalLiveTradingOperatorAutoDeactivate =
    summarizeCapitalLiveTradingOperatorAutoDeactivate(
      await loadCapitalLiveTradingOperatorAutoDeactivate(repoRoot),
    );
  const capitalLiveTradingOperatorAutoDeactivateReceiptGate =
    summarizeCapitalLiveTradingOperatorAutoDeactivateReceiptGate(
      await loadCapitalLiveTradingOperatorAutoDeactivateReceiptGate(repoRoot),
    );
  const completionContext = {
    capitalServiceStatus,
    capitalOverseasStaleRecovery,
    capitalDomesticQuoteComGuard,
    capitalFreshQuoteGate,
    capitalTelegramOwnerCheck,
    capitalPaperFillSimulation,
    capitalPaperStrategyEvaluation,
    capitalPaperAutoReview,
    capitalPaperErrorRepair,
    blackboxAutonomy,
    blackboxSync,
    capitalStrategyFillSimulation,
    hermesNuwaBridge,
    autonomousInventory: await collectAutonomousInventory(repoRoot),
  };
  const riskControlsObservedBlocked =
    capitalServiceStatus.riskControlsObservedLive || capitalServiceStatus.riskControlsObservedWrite;
  const autoDeactivateReceiptPending = isCapitalLiveTradingOperatorAutoDeactivateReceiptPending(
    capitalLiveTradingOperatorAutoDeactivateReceiptGate,
  );
  const riskControlsObservedTaskId = autoDeactivateReceiptPending
    ? "capital_live_trading_operator_auto_deactivate_receipt_check"
    : "capital_live_trading_operator_auto_deactivate";
  const nextTaskCandidate = riskControlsObservedBlocked
    ? selectionContext.taskPool.find((task) => task.id === riskControlsObservedTaskId)
    : pickNextIncompleteTask(selectionContext.taskPool, selectedTask.id, completionContext);
  const baseNextSafeReason = riskControlsObservedBlocked
    ? autoDeactivateReceiptPending
      ? "risk-controls live/write observed and auto-deactivate receipt is pending; verify receipt gate before repeating auto-deactivate"
      : "risk-controls live/write observed; generate operator auto-deactivate report before live-readiness retry"
    : quoteBlockers.length > 0
      ? "quote freshness or session gate blocked; run highest-value read-only hardening task"
      : "quote/session gate ready; run read-only market monitor task";
  const { task: nextTask, reason: nextSafeReason } = await resolveTaskWithTimeoutBackoff(
    repoRoot,
    selectionContext.taskPool,
    nextTaskCandidate,
    baseNextSafeReason,
  );
  const normalizedNextTaskId =
    normalizeTextValue(nextTask?.id) ??
    normalizeTextValue(nextTaskCandidate?.id) ??
    normalizeTextValue(selectedTask.id) ??
    "autonomous_inventory_check";
  const normalizedNextTaskCommand =
    normalizeTextValue(
      nextTask?.command && Array.isArray(nextTask?.args)
        ? [nextTask.command, ...nextTask.args].join(" ")
        : "",
    ) ??
    normalizeTextValue(
      nextTaskCandidate?.command && Array.isArray(nextTaskCandidate?.args)
        ? [nextTaskCandidate.command, ...nextTaskCandidate.args].join(" ")
        : "",
    ) ??
    [selectedTask.command, ...selectedTask.args].join(" ");
  const normalizedNextTaskReason =
    normalizeTextValue(nextSafeReason) ?? normalizeTextValue(baseNextSafeReason) ?? "待刷新";
  const nextSafeTaskCardId = resolveNextSafeTaskCardIdFromGraph(
    normalizedNextTaskId,
    await readJson(path.join(repoRoot, CARD_FRAMEWORK_GRAPH_REL)),
  );
  const nextSafeTaskCardProposal = await buildNextSafeTaskCardProposal(
    repoRoot,
    normalizedNextTaskId,
    nextSafeTaskCardId,
  );
  const resolverCandidatesReport = await readJson(
    path.join(repoRoot, RESOLVER_CANDIDATES_REPORT_REL),
  );
  const nextSafeTaskResolverCandidate = resolveNextSafeTaskResolverCandidate(
    normalizedNextTaskId,
    resolverCandidatesReport,
  );

  const report = {
    schema: RUNNER_SCHEMA,
    generatedAt: finishedAt,
    mode: "run",
    lane: selectionContext.lane,
    readOnlyMode: true,
    core_result: reportWorkflow.finalStatus === "pass" ? "success" : "failed",
    task: {
      id: selectedTask.id,
      label: selectedTask.label,
      command: selectedTask.command,
      args: selectedTask.args,
      fullCommand: [selectedTask.command, ...selectedTask.args].join(" "),
      startedAt,
      finishedAt,
      durationMs: commandResult.durationMs,
      exitCode: commandResult.exitCode,
    },
    changed_files: [],
    validation_result: {
      card_framework_preflight: cardFrameworkPreflight,
      command_exit_code: commandResult.exitCode,
      command_error_code: commandResult.errorCode ?? null,
      command_direct_fallback: taskRun.fallback,
      report_workflow: reportWorkflow,
      quote_status_file_exists: quoteStatus !== null,
      quote_status: quoteStatus?.status ?? "unknown",
      capital_service_status: capitalServiceStatus,
      capital_domestic_quote_com_guard: capitalDomesticQuoteComGuard,
      capital_overseas_stale_recovery: capitalOverseasStaleRecovery,
      capital_fresh_quote_gate_latest: capitalFreshQuoteGate,
      market_session: quoteStatus?.session?.marketSession ?? "unknown",
      trading_open:
        typeof quoteStatus?.session?.tradingOpen === "boolean"
          ? quoteStatus.session.tradingOpen
          : null,
      capital_quick_quote_latest: capitalQuickQuote,
      capital_telegram_owner_check: capitalTelegramOwnerCheck,
      capital_core_product_freshness_matrix: capitalCoreProductMatrix,
      capital_paper_fill_simulation: capitalPaperFillSimulation,
      capital_paper_strategy_evaluation: capitalPaperStrategyEvaluation,
      capital_paper_auto_review: capitalPaperAutoReview,
      capital_paper_error_repair: capitalPaperErrorRepair,
      blackbox_autonomy: blackboxAutonomy,
      blackbox_sync: blackboxSync,
      capital_strategy_fill_simulation: capitalStrategyFillSimulation,
      hermes_nuwa_bridge: hermesNuwaBridge,
      capital_paper_assistant_state: capitalPaperAssistantState,
      capital_live_trading_approval_summary: capitalLiveTradingApprovalSummary,
      capital_live_trading_approval_telegram_publish: capitalLiveTradingApprovalTelegramPublish,
      capital_live_trading_operator_auto_deactivate: capitalLiveTradingOperatorAutoDeactivate,
      capital_live_trading_operator_auto_deactivate_receipt_refresh:
        capitalLiveTradingOperatorAutoDeactivateReceiptRefresh,
      capital_live_trading_operator_auto_deactivate_receipt_gate:
        capitalLiveTradingOperatorAutoDeactivateReceiptGate,
      next_safe_task_card_proposal: nextSafeTaskCardProposal,
      resolver_candidates_report: {
        exists: resolverCandidatesReport !== null,
        path: RESOLVER_CANDIDATES_REPORT_REL,
        schema: resolverCandidatesReport?.schema ?? null,
        totalCandidates: resolverCandidatesReport?.summary?.totalCandidates ?? null,
        autoExecutable: resolverCandidatesReport?.summary?.autoExecutable ?? null,
      },
    },
    remaining_blockers: [
      ...quoteBlockers,
      ...capitalServiceStatusBlockers.filter((blocker) => !quoteBlockers.includes(blocker)),
      ...capitalOverseasStaleRecoveryBlockers.filter((blocker) => !quoteBlockers.includes(blocker)),
      ...capitalDomesticQuoteComGuardBlockers.filter((blocker) => !quoteBlockers.includes(blocker)),
      ...capitalQuickQuoteBlockers,
      ...capitalTelegramOwnerBlockers,
      ...capitalCoreProductMatrixBlockers,
      ...(blackboxAutonomy.exists && blackboxAutonomy.hardStop
        ? ["blackbox_hard_stop_active"]
        : []),
      ...(blackboxAutonomy.exists && blackboxAutonomy.noOrderWrite !== true
        ? ["blackbox_no_order_write_violation"]
        : []),
      ...(blackboxAutonomy.exists && blackboxAutonomy.allowLiveTrading === true
        ? ["blackbox_live_trading_violation"]
        : []),
      ...(cardFrameworkPreflight.ok ? [] : ["BLOCKED_CARD_FRAMEWORK"]),
      ...(reportWorkflow.consistency === "inconsistent"
        ? ["report_workflow_consistency_mismatch"]
        : []),
    ],
    next_safe_task: {
      id: normalizedNextTaskId,
      command: normalizedNextTaskCommand,
      reason: normalizedNextTaskReason,
      card_id: nextSafeTaskCardId,
      proposal_report_path: nextSafeTaskCardProposal.reportPath,
      resolver_candidate_id: nextSafeTaskResolverCandidate?.id ?? null,
      resolver_candidate_report_path: nextSafeTaskResolverCandidate?.report_path ?? null,
      resolver_candidate: nextSafeTaskResolverCandidate,
    },
    dmad_validation_hint: buildDmadValidationHint(),
    risk: cardFrameworkPreflight.ok
      ? "read-only controlled loop; no broker writes and no external code execution"
      : "task command skipped because original architecture card framework preflight failed",
    rollback_path:
      "git checkout -- scripts/openclaw-controlled-task-runner.mjs scripts/check-openclaw-controlled-task-runner.mjs scripts/openclaw-controlled-task-runner-telegram-publish.mjs package.json scripts/openclaw-autonomous-inventory.mjs docs/codex-task-dmad-speedup.md docs/automation/autonomous-runtime.md docs/automation/module-skill-inventory.md",
  };

  report.dmad_publish_status = await readLatestDmadPublishStatus(repoRoot);
  let telegramPaths = await writeTelegramSummary(repoRoot, report);
  const telegramPublish = await runTelegramPublishBridge(repoRoot);
  report.validation_result.telegram_publish = telegramPublish;
  report.dmad_publish_status = buildDmadPublishStatus(telegramPublish);
  telegramPaths = await writeTelegramSummary(repoRoot, report);

  const reportPaths = await writeRunReport(repoRoot, report);

  // ── Hermes 自動學習記錄（任務結束後自動寫入 learning-state.json）────────────
  await autoHermesLearn(repoRoot, selectedTask, commandResult.exitCode, report);

  return { report, reportPaths: { ...reportPaths, ...telegramPaths } };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const repoRoot = process.cwd();
  const nextSafe = await chooseNextSafeTask(repoRoot);

  if (options.mode === "next-safe") {
    const nextSafeGraph = await readJson(path.join(repoRoot, CARD_FRAMEWORK_GRAPH_REL));
    const nextSafeCardId = resolveNextSafeTaskCardIdFromGraph(nextSafe.task.id, nextSafeGraph);
    const resolverCandidatesReport = await readJson(
      path.join(repoRoot, RESOLVER_CANDIDATES_REPORT_REL),
    );
    const nextSafeResolverCandidate = resolveNextSafeTaskResolverCandidate(
      nextSafe.task.id,
      resolverCandidatesReport,
    );
    const payload = formatNextSafe(
      nextSafe.task,
      nextSafe.reason,
      nextSafe.readOnlyMode,
      nextSafeCardId,
      nextSafeResolverCandidate,
      await readLatestDmadPublishStatus(repoRoot),
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`task=${nextSafe.task.id}\n`);
      process.stdout.write(`command=${payload.task.command}\n`);
      process.stdout.write(`card_id=${payload.task.cardId ?? "none"}\n`);
      process.stdout.write(`resolver_candidate_id=${payload.task.resolverCandidateId ?? "none"}\n`);
      process.stdout.write(`machine_line=${payload.machineLine}\n`);
      process.stdout.write(`dmad_validation_command=${payload.dmad_validation_hint.command}\n`);
      process.stdout.write(`dmad_publish_status=${payload.dmad_publish_status.machineLine}\n`);
      process.stdout.write(`read_only=${String(payload.readOnlyMode)}\n`);
      process.stdout.write(`reason=${payload.reason}\n`);
    }
    return;
  }

  const explicitTask = options.taskId ? resolveTask(options.taskId) : null;
  if (options.taskId && !explicitTask) {
    throw new Error(`Unknown task id: ${String(options.taskId)}`);
  }
  const selectedTask = explicitTask ?? nextSafe.task;
  const selectionContext = {
    lane:
      nextSafe.taskPool.some((entry) => entry.id === selectedTask.id) && !explicitTask
        ? nextSafe.lane
        : MARKET_MONITOR_TASKS.some((entry) => entry.id === selectedTask.id)
          ? "market_monitor"
          : "resilience_hardening",
    taskPool:
      nextSafe.taskPool.some((entry) => entry.id === selectedTask.id) && !explicitTask
        ? nextSafe.taskPool
        : MARKET_MONITOR_TASKS.some((entry) => entry.id === selectedTask.id)
          ? MARKET_MONITOR_TASKS
          : RESILIENCE_HARDENING_TASKS,
  };
  const { report, reportPaths } = await runTask(repoRoot, selectedTask, selectionContext);

  const runnerState = await loadRunnerState(repoRoot);
  const currentRunCount = Number(runnerState.payload?.runCount ?? 0);
  await saveRunnerState(
    runnerState.path,
    selectedTask.id,
    currentRunCount + 1,
    selectionContext.lane,
    runnerState.payload,
  );

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...report,
          report_paths: reportPaths,
          telegram_summary_paths: {
            json: reportPaths.telegramJsonPath,
            markdown: reportPaths.telegramMarkdownPath,
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `controlled_task=${selectedTask.id} exit=${String(report.task.exitCode)} next=${report.next_safe_task.id}\n`,
    );
    process.stdout.write(`report=${reportPaths.runPath}\n`);
    process.stdout.write(`latest=${reportPaths.latestPath}\n`);
    process.stdout.write(`telegram=${reportPaths.telegramMarkdownPath}\n`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  await main().catch((error) => {
    process.stderr.write(
      `openclaw controlled task runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
