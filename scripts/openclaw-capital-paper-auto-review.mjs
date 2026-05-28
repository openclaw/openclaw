/**
 * openclaw-capital-paper-auto-review.mjs
 *
 * 讀取 evaluator recommendation、strategy config 及 learning registry，
 * 決定是否自動把 strategy config 的 learning.status 從 "candidate" 升為 "approved_paper"。
 *
 * 嚴格安全約束（永遠不得修改）：
 *   - promoteLiveAutomatically 維持原值
 *   - allowLiveTrading 維持原值
 *   - writeBrokerOrders 維持原值
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.paper-auto-review.v1";

async function tryReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, missing: true };
    }
    return { ok: false, error: err };
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function isEvaluationSourceIntegrityOk(evaluation) {
  const summary = evaluation?.summary ?? {};
  return (
    evaluation?.rules?.rule_source_integrity?.pass === true &&
    (summary.invalid_intent_count ?? 0) === 0 &&
    (summary.unsafe_intent_count ?? 0) === 0 &&
    (summary.blocked_legacy_alias_count ?? 0) === 0 &&
    (summary.normalized_legacy_alias_count ?? 0) === 0
  );
}

function collectEvaluationFailedRules(evaluation) {
  const failedRules = Array.isArray(evaluation?.failedRules)
    ? evaluation.failedRules
        .map((rule) => {
          if (typeof rule === "string" && rule.trim().length > 0) {
            return rule.trim();
          }
          if (typeof rule?.id === "string" && rule.id.trim().length > 0) {
            return rule.id.trim();
          }
          return "";
        })
        .filter((rule) => rule.length > 0)
    : [];
  const blockerRules = Array.isArray(evaluation?.blockers)
    ? evaluation.blockers
        .map((blocker) => {
          if (typeof blocker?.id === "string" && blocker.id.trim().length > 0) {
            return blocker.id.trim();
          }
          if (typeof blocker?.message === "string" && blocker.message.trim().length > 0) {
            return blocker.message.trim();
          }
          return "";
        })
        .filter((rule) => rule.length > 0)
    : [];
  const combined = [...new Set([...failedRules, ...blockerRules])];
  if (combined.length === 0 && evaluation?.recommendation === "reject") {
    return ["evaluation_rejected"];
  }
  return combined;
}

function buildTuningPlan({ evaluation, failedRules }) {
  const summary = evaluation?.summary ?? {};
  const failed = new Set(failedRules);
  const actions = [];

  if (failed.has("rule_avg_pnl") || (summary.avg_pnl_ticks ?? 0) <= 0) {
    actions.push({
      id: "improve_average_pnl",
      metric: "avg_pnl_ticks",
      current: summary.avg_pnl_ticks ?? 0,
      target: ">0",
      action:
        "filter weak current paper candidates and rerun paper fill simulation with the next fresh quote digest",
    });
  }

  if (failed.has("rule_sharpe") || (summary.sharpe_proxy ?? 0) < 0.3) {
    actions.push({
      id: "improve_sharpe_proxy",
      metric: "sharpe_proxy",
      current: summary.sharpe_proxy ?? 0,
      target: ">=0.3",
      action:
        "prefer lower-variance paper candidates before auto-review and keep promotion blocked until sharpe recovers",
    });
  }

  if (failed.has("rule_win_streak") || (summary.win_streak_max ?? 0) < 3) {
    actions.push({
      id: "increase_win_streak_depth",
      metric: "win_streak_max",
      current: summary.win_streak_max ?? 0,
      target: ">=3",
      action:
        "collect additional paper outcomes before treating the current microstructure strategy as newly approved",
    });
  }

  if (
    failed.has("rule_monte_carlo_positive_rate") ||
    (summary.monte_carlo_positive_rate ?? 0) < 0.55
  ) {
    actions.push({
      id: "improve_monte_carlo_positive_rate",
      metric: "monte_carlo_positive_rate",
      current: summary.monte_carlo_positive_rate ?? 0,
      target: ">=0.55",
      action:
        "rerun current paper intents after a new quote digest and reject promotion if the positive-rate gate remains weak",
    });
  }

  if (failed.has("strategy_fill_promotion_gate_blocked")) {
    actions.push({
      id: "clear_strategy_fill_promotion_gate",
      metric: "strategy_fill_promotion_gate_status",
      current: summary.strategy_fill_promotion_gate_status ?? "blocked",
      target: "not_blocked",
      action:
        "rerun strategy fill simulation and tail-risk repair; do not promote while tail_risk_positive remains present",
    });
  }

  return {
    status: actions.length > 0 ? "tuning_required" : "observe_next_digest",
    paperOnly: true,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    failedRules,
    actions,
    commands: [
      "pnpm capital:trade:current-paper-intents:check",
      "pnpm capital:paper-hft:fill-simulation",
      "pnpm capital:paper-hft:evaluate",
      "pnpm capital:paper-hft:auto-review:check",
      "pnpm capital:strategy:tail-risk-repair:check",
    ],
  };
}

/**
 * 執行 paper auto-review（candidate → approved_paper 晉升判斷）。
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.evaluationPath]
 * @param {string} [options.strategyPath]
 * @param {string} [options.learningRegistryPath]
 * @param {string} [options.reviewReportPath]
 * @param {boolean} [options.writeState=false] — 只有 true 才會實際寫入
 */
export async function runCapitalPaperAutoReview(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const evaluationPath = options.evaluationPath
    ? path.resolve(options.evaluationPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-strategy-evaluation.json");
  const strategyPath = options.strategyPath
    ? path.resolve(options.strategyPath)
    : path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
  const learningRegistryPath = options.learningRegistryPath
    ? path.resolve(options.learningRegistryPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-learning-registry.json");
  const reviewReportPath = options.reviewReportPath
    ? path.resolve(options.reviewReportPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-auto-review-latest.json");
  const writeState = options.writeState === true;
  const generatedAt = new Date().toISOString();

  async function finalize(result) {
    const report = {
      ...result,
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      reportPath: reviewReportPath,
      inputs: {
        evaluationPath,
        strategyPath,
        learningRegistryPath,
      },
    };
    if (writeState) {
      await writeJson(reviewReportPath, report);
    }
    return report;
  }

  // 讀取三份檔案
  const [evalResult, stratResult, regResult] = await Promise.all([
    tryReadJson(evaluationPath),
    tryReadJson(strategyPath),
    tryReadJson(learningRegistryPath),
  ]);

  if (!evalResult.ok || !stratResult.ok || !regResult.ok) {
    return finalize({
      schema: SCHEMA,
      generatedAt,
      status: "no_data",
      promoted: false,
      promotionBlocked: true,
      currentEvaluationApproved: false,
      conditionsMet: {},
      safetyChecks: {
        liveStillBlocked: false,
        promoteLiveAutoStillFalse: false,
        writeBrokerOrdersStillFalse: false,
      },
      failedRules: ["missing_input"],
      tuningPlan: {
        status: "missing_input",
        paperOnly: true,
        liveTradingEnabled: false,
        writeBrokerOrders: false,
        failedRules: ["missing_input"],
        actions: [
          {
            id: "restore_required_inputs",
            metric: "input_files",
            current: "missing",
            target: "present",
            action:
              "regenerate paper evaluator, strategy config, and learning registry before auto-review",
          },
        ],
        commands: [
          "pnpm capital:paper-hft:fill-simulation",
          "pnpm capital:paper-hft:evaluate",
          "pnpm capital:paper-hft:auto-review:check",
        ],
      },
      nextAction: "補齊 paper evaluator、strategy config、learning registry 後重跑 auto-review。",
    });
  }

  const evaluation = evalResult.data;
  const strategy = stratResult.data;
  const registry = regResult.data;

  // 安全複查（讀取原值，永遠不修改這三個欄位）
  const safetyChecks = {
    liveStillBlocked: strategy.allowLiveTrading === false,
    promoteLiveAutoStillFalse: strategy.learning?.promoteLiveAutomatically === false,
    writeBrokerOrdersStillFalse: strategy.writeBrokerOrders === false,
  };

  // 若安全複查失敗，立即回傳 safety_blocked
  if (
    !safetyChecks.liveStillBlocked ||
    !safetyChecks.promoteLiveAutoStillFalse ||
    !safetyChecks.writeBrokerOrdersStillFalse
  ) {
    return finalize({
      schema: SCHEMA,
      generatedAt,
      status: "safety_blocked",
      promoted: false,
      promotionBlocked: true,
      currentEvaluationApproved: false,
      conditionsMet: {},
      safetyChecks,
      failedRules: ["safety_lock_failed"],
      tuningPlan: {
        status: "safety_blocked",
        paperOnly: true,
        liveTradingEnabled: false,
        writeBrokerOrders: false,
        failedRules: ["safety_lock_failed"],
        actions: [
          {
            id: "restore_safety_lock",
            metric: "safety_lock",
            current: "failed",
            target: "live/write disabled",
            action: "restore paper-only safety flags before any paper auto-review can continue",
          },
        ],
        commands: ["pnpm capital:paper-hft:auto-review:check"],
      },
      nextAction: "修復 safety lock；不得晉升或送單。",
    });
  }

  const evaluationSourceIntegrityOk = isEvaluationSourceIntegrityOk(evaluation);
  const evaluationFailedRules = collectEvaluationFailedRules(evaluation);
  if (!evaluationSourceIntegrityOk) {
    return finalize({
      schema: SCHEMA,
      generatedAt,
      status:
        strategy.learning?.status === "approved_paper"
          ? "approved_paper_integrity_blocked"
          : "evaluation_integrity_blocked",
      promoted: false,
      promotionBlocked: true,
      currentEvaluationApproved: false,
      conditionsMet: {},
      safetyChecks,
      evaluationRef: {
        recommendation: evaluation.recommendation ?? "",
        passCount: evaluation.passCount ?? 0,
        ruleCount: evaluation.ruleCount ?? 0,
        sourceIntegrityOk: false,
      },
      summary: evaluation.summary ?? {},
      failedRules: [...evaluationFailedRules, "source_integrity_failed"],
      tuningPlan: buildTuningPlan({
        evaluation,
        failedRules: [...evaluationFailedRules, "source_integrity_failed"],
      }),
      reason: "最新 evaluator 未通過來源完整性檢查；不可視為新通過。",
      nextAction:
        "阻擋 paper auto-review；修正錯誤商品/unsafe intent 後重跑 fill simulation 與 evaluator。",
    });
  }

  // 若目前已是 approved_paper，仍需反映最新 evaluator 是否已退回 reject。
  if (strategy.learning?.status === "approved_paper") {
    return finalize({
      schema: SCHEMA,
      generatedAt,
      status:
        evaluation.recommendation === "reject"
          ? "approved_paper_current_rejected"
          : "already_approved",
      promoted: false,
      promotionBlocked: evaluation.recommendation === "reject",
      currentEvaluationApproved: evaluation.recommendation !== "reject",
      conditionsMet: {},
      safetyChecks,
      evaluationRef: {
        recommendation: evaluation.recommendation ?? "",
        passCount: evaluation.passCount ?? 0,
        ruleCount: evaluation.ruleCount ?? 0,
        sourceIntegrityOk: true,
      },
      summary: evaluation.summary ?? {},
      failedRules: evaluationFailedRules,
      tuningPlan: buildTuningPlan({ evaluation, failedRules: evaluationFailedRules }),
      reason:
        evaluation.recommendation === "reject"
          ? "最新 paper evaluator 為 reject；不降級既有 approved_paper，但禁止視為新通過。"
          : "策略已是 approved_paper；本輪未執行晉升。",
      nextAction:
        evaluation.recommendation === "reject"
          ? "保留舊 paper approval 作相容狀態；目前策略禁止新晉升，需修正策略或增加有效樣本。"
          : "維持 paper approval；仍不可自動升級真單。",
    });
  }

  // 評估晉升條件
  const counters = registry.counters ?? {};
  const minReadyCycles = strategy.learning?.minReadyCyclesForPaper ?? 2;
  const conditionsMet = {
    recommendation_promote: evaluation.recommendation === "promote",
    status_is_candidate: strategy.learning?.status === "candidate",
    consecutive_ready_cycles: (counters.consecutiveReadyCycles ?? 0) >= minReadyCycles,
    no_consecutive_readiness_blocks: (counters.consecutiveReadinessBlocks ?? 0) === 0,
    promote_live_auto_false: strategy.learning?.promoteLiveAutomatically === false,
    source_integrity_ok: evaluationSourceIntegrityOk,
  };

  const allConditionsMet = Object.values(conditionsMet).every(Boolean);

  if (!allConditionsMet) {
    return finalize({
      schema: SCHEMA,
      generatedAt,
      status: "conditions_not_met",
      promoted: false,
      promotionBlocked: true,
      currentEvaluationApproved: false,
      conditionsMet,
      safetyChecks,
      evaluationRef: {
        recommendation: evaluation.recommendation ?? "",
        passCount: evaluation.passCount ?? 0,
        ruleCount: evaluation.ruleCount ?? 0,
        sourceIntegrityOk: true,
      },
      summary: evaluation.summary ?? {},
      failedRules: evaluationFailedRules,
      tuningPlan: buildTuningPlan({ evaluation, failedRules: evaluationFailedRules }),
      nextAction: "條件未滿足；維持 paper-only，重跑 fill/evaluator 或累積 readiness cycles。",
    });
  }

  // 所有條件滿足，執行晉升（若 writeState === true）
  if (writeState) {
    // 安全複查：再次確認三個安全欄位不被變動
    if (strategy.allowLiveTrading !== false) {
      throw new Error("安全錯誤：strategy.allowLiveTrading 不是 false，拒絕晉升寫入。");
    }
    if (strategy.writeBrokerOrders !== false) {
      throw new Error("安全錯誤：strategy.writeBrokerOrders 不是 false，拒絕晉升寫入。");
    }
    if (strategy.learning?.promoteLiveAutomatically !== false) {
      throw new Error(
        "安全錯誤：strategy.learning.promoteLiveAutomatically 不是 false，拒絕晉升寫入。",
      );
    }

    // 只改 learning.status，加上 approvedAt/approvedBy，其餘原封不動
    const updated = {
      ...strategy,
      learning: {
        ...strategy.learning,
        status: "approved_paper",
        approvedAt: generatedAt,
        approvedBy: "auto-review",
        // 安全欄位維持原值（明確保留）
        promoteLiveAutomatically: false,
      },
      // 安全欄位維持原值（明確保留）
      allowLiveTrading: false,
      writeBrokerOrders: false,
    };

    const strategyText = `${JSON.stringify(updated, null, 2)}\n`;
    await fs.writeFile(strategyPath, strategyText, "utf8");
  }

  return finalize({
    schema: SCHEMA,
    generatedAt,
    status: "promoted",
    promoted: true,
    promotionBlocked: false,
    currentEvaluationApproved: true,
    conditionsMet,
    safetyChecks,
    evaluationRef: {
      recommendation: evaluation.recommendation ?? "",
      passCount: evaluation.passCount ?? 0,
      ruleCount: evaluation.ruleCount ?? 0,
      sourceIntegrityOk: true,
    },
    summary: evaluation.summary ?? {},
    failedRules: [],
    tuningPlan: buildTuningPlan({ evaluation, failedRules: [] }),
    nextAction: "已晉升 paper approval；仍需 live promotion gate 才能進入真單審查。",
  });
}

// --- CLI 入口 ---
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }
  const repoRoot = flag("--repo-root");
  const writeState = args.includes("--write-state");
  const jsonMode = args.includes("--json");

  const result = await runCapitalPaperAutoReview({ repoRoot, writeState });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `schema:      ${result.schema}`,
        `generatedAt: ${result.generatedAt}`,
        `status:      ${result.status}`,
        `promoted:    ${result.promoted}`,
        `safetyChecks.liveStillBlocked:          ${result.safetyChecks?.liveStillBlocked}`,
        `safetyChecks.promoteLiveAutoStillFalse: ${result.safetyChecks?.promoteLiveAutoStillFalse}`,
        `safetyChecks.writeBrokerOrdersStillFalse: ${result.safetyChecks?.writeBrokerOrdersStillFalse}`,
      ].join("\n") + "\n",
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
