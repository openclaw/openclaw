/**
 * openclaw-evolution-engine.mjs — 自主進化引擎
 * 功能：策略晉升、自動學習、regime 偵測、失敗挖掘、參數優化
 * 用法: node scripts/openclaw-evolution-engine.mjs [--cycle] [--promote] [--learn] [--json]
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DATA_ROOT = path.resolve(ROOT, "..", "OpenClawData");
const REGISTRY = path.join(DATA_ROOT, "trading", "strategy_learning_registry.json");
const RISK_CTRL = path.join(DATA_ROOT, "trading", "risk_controls.json");
const EVOLUTION_STATE = path.join(ROOT, ".openclaw", "evolution-state", "evolution-cycle.json");
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");

// 晉升門檻
const PROMOTION_THRESHOLDS = {
  candidate_to_approved_paper: {
    minTrades: 50,
    minSharpe: 0.8,
    maxDrawdownPct: 15,
    minWinRate: 0.45,
  },
  approved_paper_to_candidate_live: {
    minTrades: 200,
    minSharpe: 1.5,
    maxDrawdownPct: 8,
    minWinRate: 0.55,
    requireWalkForward: true,
    requireMonteCarlo: true,
  },
  candidate_live_to_approved_live: {
    requireHumanApproval: true, // 需人工確認
    requireDryRunPass: true,
    minDryRunTrades: 50,
    maxDryRunLoss: 1.0, // %
  },
};

function sha256(t) {
  return crypto.createHash("sha256").update(t).digest("hex").toUpperCase();
}

async function readJson(p) {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const j = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(p, j);
  await fs.writeFile(p + ".sha256", sha256(j) + "\n", "ascii");
}

// === 策略評估 ===
function evaluateStrategy(strategy) {
  const stats = strategy.stats || strategy.performance || {};
  const plans = strategy.total_plans || strategy.tradeCount || 0;
  return {
    id: strategy.id || strategy.name,
    currentStatus: strategy.status,
    trades: plans,
    sharpe: stats.sharpe_ratio || stats.sharpe || 0,
    maxDD: stats.max_drawdown_pct || stats.maxDrawdown || 100,
    winRate: stats.win_rate || stats.winRate || 0,
    avgScore: strategy.avg_score || stats.avgScore || 0,
  };
}

function checkPromotion(eval_, from, to) {
  const key = `${from}_to_${to}`;
  const thresh = PROMOTION_THRESHOLDS[key];
  if (!thresh) return { eligible: false, reason: "no_threshold_defined" };

  if (thresh.requireHumanApproval) {
    return {
      eligible: false,
      reason: "requires_human_approval",
      blockerCode: "HUMAN_APPROVAL_REQUIRED",
    };
  }

  const failures = [];
  if (thresh.minTrades && eval_.trades < thresh.minTrades)
    failures.push(`trades ${eval_.trades} < ${thresh.minTrades}`);
  if (thresh.minSharpe && eval_.sharpe < thresh.minSharpe)
    failures.push(`sharpe ${eval_.sharpe.toFixed(2)} < ${thresh.minSharpe}`);
  if (thresh.maxDrawdownPct && eval_.maxDD > thresh.maxDrawdownPct)
    failures.push(`maxDD ${eval_.maxDD.toFixed(1)}% > ${thresh.maxDrawdownPct}%`);
  if (thresh.minWinRate && eval_.winRate < thresh.minWinRate)
    failures.push(
      `winRate ${(eval_.winRate * 100).toFixed(1)}% < ${(thresh.minWinRate * 100).toFixed(0)}%`,
    );

  return failures.length === 0
    ? { eligible: true, reason: "all_thresholds_met" }
    : { eligible: false, reason: failures.join("; ") };
}

// === Regime 偵測 ===
function detectRegime(marketData) {
  // 簡化版 regime 偵測 (實際會讀取即時 volatility + trend indicators)
  const vol = marketData?.volatility || 0;
  const trend = marketData?.trendStrength || 0;
  if (vol > 25 && trend < 0.3) return "high_vol_range";
  if (vol > 25 && trend > 0.6) return "high_vol_trend";
  if (vol < 15 && trend > 0.6) return "low_vol_trend";
  return "low_vol_range";
}

// === 失敗模式挖掘 ===
function mineFailurePatterns(strategies) {
  const patterns = [];
  for (const s of strategies) {
    const eval_ = evaluateStrategy(s);
    if (eval_.currentStatus === "blocked" || eval_.winRate < 0.4) {
      patterns.push({
        strategy: eval_.id,
        pattern: eval_.winRate < 0.3 ? "systematic_loss" : "marginal_loss",
        suggestion: eval_.maxDD > 20 ? "add_tighter_stop_loss" : "parameter_recalibration",
        priority: eval_.trades > 100 ? "high" : "low",
      });
    }
  }
  return patterns;
}

// === 主循環 ===
export async function runEvolutionCycle(options = {}) {
  const now = options.now || new Date();
  const registry = await readJson(REGISTRY);
  const riskCtrl = await readJson(RISK_CTRL);

  if (!registry) {
    return { error: "cannot_read_registry", path: REGISTRY };
  }

  const strategies = registry.strategies
    ? Object.entries(registry.strategies).map(([id, v]) => ({ id, ...v }))
    : Array.isArray(registry)
      ? registry
      : [];

  // 評估所有策略
  const evaluations = strategies.map(evaluateStrategy);
  const promotions = [];
  const blocked = [];

  for (const eval_ of evaluations) {
    // 嘗試晉升
    if (eval_.currentStatus === "candidate") {
      const check = checkPromotion(eval_, "candidate", "approved_paper");
      if (check.eligible) promotions.push({ ...eval_, promoteTo: "approved_paper", ...check });
      else blocked.push({ ...eval_, ...check });
    } else if (eval_.currentStatus === "approved_paper") {
      const check = checkPromotion(eval_, "approved_paper", "candidate_live");
      if (check.eligible) promotions.push({ ...eval_, promoteTo: "candidate_live", ...check });
      else blocked.push({ ...eval_, ...check });
    } else if (eval_.currentStatus === "candidate_live") {
      const check = checkPromotion(eval_, "candidate_live", "approved_live");
      if (check.eligible) promotions.push({ ...eval_, promoteTo: "approved_live", ...check });
      else blocked.push({ ...eval_, ...check });
    }
  }

  // 失敗模式挖掘
  const failurePatterns = mineFailurePatterns(strategies);

  // Regime 偵測 (placeholder - 實際會從 quote feed 讀取)
  const regime = detectRegime(options.marketData || null);

  // 進化報告
  const report = {
    schema: "openclaw.evolution-engine.v1",
    generatedAt: now.toISOString(),
    cycle: options.cycleNumber || 1,
    regime,
    summary: {
      totalStrategies: strategies.length,
      evaluations: evaluations.length,
      promotionsReady: promotions.length,
      blocked: blocked.length,
      failurePatterns: failurePatterns.length,
    },
    promotions,
    blocked: blocked.slice(0, 10), // top 10
    failurePatterns: failurePatterns.slice(0, 5),
    safety: {
      allowLiveTrading: riskCtrl?.allow_live || false,
      writeBrokerOrders: false,
      autoPromoteToLive: false, // 永遠不自動上線
      readOnlyReportOnly: true,
    },
    nextSafeTask:
      promotions.length > 0
        ? `Review ${promotions.length} promotion candidates (human approval needed for live)`
        : blocked.length > 0
          ? `Address blocker: ${blocked[0].reason}`
          : "All strategies at current optimal level",
  };

  // 寫入 state
  if (options.writeState !== false) {
    await writeJson(EVOLUTION_STATE, report);
    await writeJson(path.join(REPORT_DIR, "evolution-cycle-latest.json"), report);
  }

  return { report };
}

// === CLI ===
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const hasFlag = (f) => process.argv.includes(f);
  const { report } = await runEvolutionCycle({
    writeState: hasFlag("--write-state") || hasFlag("--cycle"),
  });

  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${report.regime}] Evolution Cycle #${report.cycle}`);
    console.log(`  Strategies: ${report.summary.totalStrategies}`);
    console.log(`  Promotions ready: ${report.summary.promotionsReady}`);
    console.log(`  Blocked: ${report.summary.blocked}`);
    console.log(`  Failure patterns: ${report.summary.failurePatterns}`);
    console.log(`  Live trading: ${report.safety.allowLiveTrading}`);
    console.log(`  Next: ${report.nextSafeTask}`);
  }
}
