/**
 * openclaw-capital-paper-strategy-evaluator.mjs
 *
 * 讀取 fill simulation 結果，用規則型評估策略品質，輸出 recommendation。
 *
 * 安全約束：
 *   allowLiveTrading: false（絕不設為 true）
 *   writeBrokerOrders: false（絕不設為 true）
 *   promoteLiveAutomatically: false（絕不設為 true）
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.paper-strategy-evaluation.v1";
const RULE_LABELS = {
  rule_fill_rate: "成交率",
  rule_avg_pnl: "平均損益",
  rule_sharpe: "Sharpe proxy",
  rule_win_streak: "連勝深度",
  rule_loss_streak: "連敗限制",
  rule_monte_carlo_positive_rate: "Monte Carlo 正報酬率",
  rule_source_integrity: "來源完整性",
};

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { __missing: true };
    }
    return {
      __missing: true,
      __error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readJsonlMetadata(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      recordCount: lines.length,
      digest: lines.length > 0 ? sha256Text(`${lines.join("\n")}\n`) : "",
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        recordCount: 0,
        digest: "",
      };
    }
    throw err;
  }
}

/**
 * 評估 paper trading 策略表現。
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.simulationPath]
 * @param {string} [options.currentIntentsPath]
 * @param {string} [options.strategyFillSimulationPath]
 * @param {string} [options.outputPath]
 */
export async function runCapitalPaperStrategyEvaluator(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const simulationPath = options.simulationPath
    ? path.resolve(options.simulationPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-fill-simulation.json");
  const strategyFillSimulationPath = options.strategyFillSimulationPath
    ? path.resolve(options.strategyFillSimulationPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json");
  const currentIntentsPath = options.currentIntentsPath
    ? path.resolve(options.currentIntentsPath)
    : "";
  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-strategy-evaluation.json");
  const generatedAt = new Date().toISOString();

  // 讀取 simulation 報告
  let sim;
  try {
    const raw = await fs.readFile(simulationPath, "utf8");
    sim = JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") {
      const report = {
        schema: SCHEMA,
        generatedAt,
        status: "no_simulation",
        readOnly: true,
        loginAttempted: false,
        liveTradingEnabled: false,
        writeTradingEnabled: false,
        brokerOrderPathEnabled: false,
        recommendation: "reject",
        passCount: 0,
        rules: {},
        failedRules: ["no_simulation"],
        nextAction: "先執行 pnpm capital:paper-hft:fill-simulation",
        safetyLock: {
          allowLiveTrading: false,
          writeBrokerOrders: false,
          promoteLiveAutomatically: false,
        },
      };
      await writeJsonWithSha(outputPath, report);
      return report;
    }
    throw err;
  }
  const strategyFillSimulation = await readJsonOptional(strategyFillSimulationPath);

  const s = sim.stats ?? {};
  const monteCarlo = sim.monteCarlo ?? {};
  const simIntentSourcePath = path.resolve(
    currentIntentsPath ||
      sim.source?.actualPath ||
      sim.source?.intentsPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-intents.jsonl"),
  );
  const currentIntentSource = await readJsonlMetadata(simIntentSourcePath);
  const currentIntentRecordCount = currentIntentSource.recordCount;
  const simulationSourceDigest = String(sim.source?.sourceDigest ?? "");
  const simulationSourceRecordCount = Number(sim.source?.sourceRecordCount ?? 0);
  const staleSimulationDigestMismatch =
    (s.total_intents ?? 0) > 0 &&
    sim.source?.fallbackUsed !== true &&
    simulationSourceDigest.length > 0 &&
    currentIntentSource.digest !== simulationSourceDigest;
  const staleSimulationSource =
    (s.total_intents ?? 0) > 0 &&
    sim.source?.fallbackUsed !== true &&
    (currentIntentRecordCount <= 0 || staleSimulationDigestMismatch);
  const strategyFillSafety = strategyFillSimulation.safetyLock ?? {};
  const strategyFillPromotionGate = strategyFillSimulation.promotionGate ?? {};
  const strategyFillPromotionGateBlocked =
    strategyFillPromotionGate.status === "blocked" ||
    (strategyFillSimulation.__missing !== true &&
      strategyFillSimulation.recommendation === "hold" &&
      strategyFillSafety.executionEligible === false &&
      strategyFillSafety.promotionBlocked === true);
  const strategySnapshotOnly =
    (s.total_intents ?? 0) <= 0 &&
    strategyFillSimulation.__missing !== true &&
    strategyFillSimulation.status === "historical_simulated" &&
    strategyFillSafety.executionEligible === false &&
    strategyFillSafety.promotionBlocked === true;
  const simulationSafetyOk =
    sim.readOnly === true &&
    sim.liveTradingEnabled === false &&
    sim.writeTradingEnabled === false &&
    sim.brokerOrderPathEnabled === false &&
    sim.safetyLock?.allowLiveTrading === false &&
    sim.safetyLock?.writeBrokerOrders === false &&
    sim.safetyLock?.promoteLiveAutomatically === false;
  const sourceIntegrityOk =
    (s.invalid_intent_count ?? 0) === 0 &&
    (s.unsafe_intent_count ?? 0) === 0 &&
    (s.blocked_legacy_alias_count ?? 0) === 0 &&
    (s.normalized_legacy_alias_count ?? 0) === 0;

  // 5 條評估規則
  const rules = {
    rule_fill_rate: {
      pass: (s.fill_rate ?? 0) >= 0.15,
      value: s.fill_rate ?? 0,
    },
    rule_avg_pnl: {
      pass: (s.avg_pnl_ticks ?? 0) > 0,
      value: s.avg_pnl_ticks ?? 0,
    },
    rule_sharpe: {
      pass: (s.sharpe_proxy ?? 0) >= 0.3,
      value: s.sharpe_proxy ?? 0,
    },
    rule_win_streak: {
      pass: (s.win_streak_max ?? 0) >= 3,
      value: s.win_streak_max ?? 0,
    },
    rule_loss_streak: {
      pass: (s.loss_streak_max ?? Infinity) <= 10,
      value: s.loss_streak_max ?? 0,
    },
    rule_monte_carlo_positive_rate: {
      pass: (monteCarlo.positive_rate ?? 0) >= 0.55,
      value: monteCarlo.positive_rate ?? 0,
    },
    rule_source_integrity: {
      pass: sourceIntegrityOk,
      value: {
        invalid_intent_count: s.invalid_intent_count ?? 0,
        unsafe_intent_count: s.unsafe_intent_count ?? 0,
        blocked_legacy_alias_count: s.blocked_legacy_alias_count ?? 0,
        normalized_legacy_alias_count: s.normalized_legacy_alias_count ?? 0,
      },
    },
  };

  const passCount = Object.values(rules).filter((r) => r.pass).length;
  const failedRules = Object.entries(rules)
    .filter(([, rule]) => !rule.pass)
    .map(([id, rule]) => ({
      id,
      label: RULE_LABELS[id] ?? id,
      value: rule.value,
    }));

  let recommendation;
  if (
    !simulationSafetyOk ||
    !sourceIntegrityOk ||
    (s.total_intents ?? 0) <= 0 ||
    staleSimulationSource ||
    strategyFillPromotionGateBlocked
  ) {
    recommendation = "reject";
  } else if (passCount >= 6) {
    recommendation = "promote";
  } else if (passCount >= 4) {
    recommendation = "review";
  } else {
    recommendation = "reject";
  }
  const blockers = [];
  if ((s.total_intents ?? 0) <= 0) {
    blockers.push({
      id: "no_current_paper_intents",
      message: "目前沒有可執行的當輪 paper intents；不可用歷史策略快照替代當輪 paper 證據。",
    });
  }
  if (staleSimulationSource) {
    blockers.push({
      id: "stale_fill_simulation_source_empty",
      message: staleSimulationDigestMismatch
        ? "fill simulation 的來源 digest 與目前 primary intent source 不一致；不可沿用過期成交模擬。"
        : "fill simulation 顯示有 intents，但目前 primary intent source 已空；不可沿用過期成交模擬。",
    });
  }
  if (strategySnapshotOnly) {
    blockers.push({
      id: "strategy_snapshot_only",
      message:
        "策略成交模擬僅為 historical_snapshot，executionEligible=false，不能推進 paper promotion。",
    });
  }
  if (strategyFillPromotionGateBlocked) {
    blockers.push({
      id: "strategy_fill_promotion_gate_blocked",
      message: `strategy fill promotion gate 尚未通過：${(strategyFillPromotionGate.blockedReasons ?? []).join("|") || "executionEligible=false"}`,
    });
  }

  const report = {
    schema: SCHEMA,
    generatedAt,
    status: "evaluated",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    source: {
      simulationPath,
      simulationSchema: sim.schema ?? "",
      simulationStatus: sim.status ?? "",
      simulationFallbackUsed: sim.source?.fallbackUsed === true,
      simulationFallbackReason: sim.source?.fallbackReason ?? "",
      currentIntentsPath: simIntentSourcePath,
      currentIntentRecordCount,
      currentIntentSourceDigest: currentIntentSource.digest,
      simulationSourceRecordCount,
      simulationSourceDigest,
      staleSimulationDigestMismatch,
      staleSimulationSource,
      strategyFillSimulationPath,
      strategyFillSimulationStatus:
        strategyFillSimulation.__missing === true
          ? "missing"
          : (strategyFillSimulation.status ?? ""),
      strategyFillSimulationRecommendation: strategyFillSimulation.recommendation ?? "",
      strategyFillSimulationMode: strategyFillSimulation.source?.simulationMode ?? "",
      strategyFillPromotionGateStatus: strategyFillPromotionGate.status ?? "",
      strategyFillPromotionGateBlockedReasons: strategyFillPromotionGate.blockedReasons ?? [],
    },
    summary: {
      total_intents: s.total_intents ?? 0,
      filled_count: s.filled_count ?? 0,
      fill_rate: s.fill_rate ?? 0,
      avg_pnl_ticks: s.avg_pnl_ticks ?? 0,
      total_pnl_ticks: s.total_pnl_ticks ?? 0,
      sharpe_proxy: s.sharpe_proxy ?? 0,
      win_streak_max: s.win_streak_max ?? 0,
      loss_streak_max: s.loss_streak_max ?? 0,
      invalid_intent_count: s.invalid_intent_count ?? 0,
      unsafe_intent_count: s.unsafe_intent_count ?? 0,
      blocked_legacy_alias_count: s.blocked_legacy_alias_count ?? 0,
      normalized_legacy_alias_count: s.normalized_legacy_alias_count ?? 0,
      monte_carlo_iterations: monteCarlo.iterations ?? 0,
      monte_carlo_positive_rate: monteCarlo.positive_rate ?? 0,
      current_intent_record_count: currentIntentRecordCount,
      simulation_source_record_count: simulationSourceRecordCount,
      strategy_fill_total_intents: strategyFillSimulation.stats?.total_intents ?? 0,
      strategy_fill_filled_count: strategyFillSimulation.stats?.filled_count ?? 0,
      strategy_fill_recommendation: strategyFillSimulation.recommendation ?? "",
      strategy_fill_simulation_mode: strategyFillSimulation.source?.simulationMode ?? "",
      strategy_fill_execution_eligible: strategyFillSafety.executionEligible ?? null,
      strategy_fill_promotion_blocked: strategyFillSafety.promotionBlocked ?? null,
      strategy_fill_promotion_gate_status: strategyFillPromotionGate.status ?? "",
    },
    passCount,
    ruleCount: Object.keys(rules).length,
    rules,
    failedRules,
    blockers,
    recommendation,
    safetyLock: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
      simulationSafetyOk,
      strategySnapshotOnly,
      strategySnapshotExecutionEligible: strategyFillSafety.executionEligible === true,
      strategyFillPromotionGateBlocked,
      staleSimulationSource,
      staleSimulationDigestMismatch,
    },
    nextAction:
      recommendation === "reject"
        ? "維持 paper-only；修正策略或增加有效樣本後重跑 fill simulation 與 evaluator。"
        : recommendation === "review"
          ? "人工審查策略統計，不可自動升級真單。"
          : "僅可進入下一層 paper promotion gate，不可直接真單。",
  };

  await writeJsonWithSha(outputPath, report);
  return report;
}

// --- CLI 入口 ---
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }
  const repoRoot = flag("--repo-root");
  const simulationPath = flag("--simulation-path");
  const outputPath = flag("--output-path");
  const jsonMode = args.includes("--json");

  const result = await runCapitalPaperStrategyEvaluator({
    repoRoot,
    simulationPath,
    outputPath,
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `schema:         ${result.schema}`,
        `generatedAt:    ${result.generatedAt}`,
        `status:         ${result.status}`,
        `passCount:      ${result.passCount}`,
        `recommendation: ${result.recommendation}`,
        ...Object.entries(result.rules ?? {}).map(
          ([k, v]) => `  ${k}: ${v.pass ? "PASS" : "FAIL"} (value=${v.value})`,
        ),
      ].join("\n") + "\n",
    );
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
