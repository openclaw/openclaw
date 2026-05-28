/**
 * openclaw-strategy-promotion-pipeline.mjs — 策略自動晉升管線
 * 讀取 strategy_learning_registry → 評估 → 提議晉升 → 寫入報告
 * 不會自動上線 (candidate_live → approved_live 需人工確認)
 * 用法: node scripts/openclaw-strategy-promotion-pipeline.mjs [--execute] [--json]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(scriptPath), "..");
const DATA_ROOT = path.resolve(ROOT, "..", "OpenClawData");
const REGISTRY_PATH = path.join(DATA_ROOT, "trading", "strategy_learning_registry.json");
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");

const THRESHOLDS = {
  to_approved_paper: { minTrades: 50, minSharpe: 0.8, maxDD: 15, minWinRate: 0.45 },
  to_candidate_live: { minTrades: 200, minSharpe: 1.5, maxDD: 8, minWinRate: 0.55 },
  // live_ready: 策略通過所有自動化晉升標準，等待人工最終核准
  to_live_ready: { minTrades: 500, minSharpe: 1.8, maxDD: 6, minWinRate: 0.58 },
  to_approved_live: { requireHuman: true },
};

function assess(strategy) {
  const s = strategy.stats || strategy.performance || {};
  return {
    id: strategy.id,
    status: strategy.status,
    trades: strategy.total_plans || s.total_trades || 0,
    sharpe: s.sharpe_ratio || s.sharpe || 0,
    maxDD: s.max_drawdown_pct || s.maxDrawdown || 100,
    winRate: s.win_rate || s.winRate || 0,
    score: strategy.avg_score || 0,
  };
}

function canPromote(a, target) {
  const t = THRESHOLDS[target];
  if (!t) {
    return { ok: false, reason: "unknown_target" };
  }
  if (t.requireHuman) {
    return { ok: false, reason: "HUMAN_APPROVAL_REQUIRED" };
  }
  const fails = [];
  if (a.trades < t.minTrades) {
    fails.push(`trades=${a.trades}<${t.minTrades}`);
  }
  if (a.sharpe < t.minSharpe) {
    fails.push(`sharpe=${a.sharpe.toFixed(2)}<${t.minSharpe}`);
  }
  if (a.maxDD > t.maxDD) {
    fails.push(`maxDD=${a.maxDD.toFixed(1)}%>${t.maxDD}%`);
  }
  if (a.winRate < t.minWinRate) {
    fails.push(`winRate=${(a.winRate * 100).toFixed(0)}%<${(t.minWinRate * 100).toFixed(0)}%`);
  }
  return fails.length === 0 ? { ok: true } : { ok: false, reason: fails.join(", ") };
}

export async function runPromotionPipeline(options = {}) {
  const now = new Date();
  let registry;
  try {
    registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
  } catch (e) {
    return { error: "cannot_read_registry", detail: e.message };
  }

  const strategies = registry.strategies
    ? Object.entries(registry.strategies).map(([id, value]) => Object.assign({ id }, value))
    : [];

  const results = [];
  for (const strat of strategies) {
    const a = assess(strat);
    let target = null,
      check = null;
    if (a.status === "candidate") {
      target = "to_approved_paper";
      check = canPromote(a, target);
    } else if (a.status === "approved_paper") {
      target = "to_candidate_live";
      check = canPromote(a, target);
    } else if (a.status === "candidate_live") {
      // candidate_live → live_ready（通過所有自動化門檻）
      target = "to_live_ready";
      check = canPromote(a, target);
    } else if (a.status === "live_ready") {
      // live_ready → approved_live（需人工最終核准）
      target = "to_approved_live";
      check = canPromote(a, target);
    }

    if (target && check) {
      results.push({ ...a, target, eligible: check.ok, reason: check.reason || "met" });
    }
  }

  const promoted = results.filter((r) => r.eligible);
  const blocked = results.filter((r) => !r.eligible);

  // 執行晉升（只限 paper 層級，live 需人工）
  if (options.execute && promoted.length > 0) {
    for (const p of promoted) {
      const newStatus = p.target.replace("to_", "");
      if (registry.strategies && registry.strategies[p.id]) {
        registry.strategies[p.id].status = newStatus;
        registry.strategies[p.id].promotedAt = now.toISOString();
        registry.strategies[p.id].promotedBy = "evolution-pipeline";
      }
    }
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  }

  const report = {
    schema: "openclaw.strategy-promotion-pipeline.v1",
    generatedAt: now.toISOString(),
    executed: options.execute || false,
    summary: {
      total: strategies.length,
      evaluated: results.length,
      promoted: promoted.length,
      blocked: blocked.length,
    },
    promoted,
    blocked: blocked.slice(0, 15),
    safety: {
      allowLiveTrading: false,
      autoPromoteToLive: false,
      readOnlyReportOnly: !options.execute,
    },
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const rptPath = path.join(REPORT_DIR, "strategy-promotion-latest.json");
  await fs.writeFile(rptPath, JSON.stringify(report, null, 2) + "\n");

  return { report, reportPath: rptPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const execute = process.argv.includes("--execute");
  const { report } = await runPromotionPipeline({ execute });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[Promotion Pipeline] evaluated=${report.summary.evaluated} promoted=${report.summary.promoted} blocked=${report.summary.blocked}`,
    );
    if (report.promoted.length) {
      report.promoted.forEach((p) => console.log(`  ↑ ${p.id} → ${p.target}`));
    }
    if (report.blocked.length) {
      report.blocked.slice(0, 5).forEach((b) => console.log(`  ✗ ${b.id}: ${b.reason}`));
    }
  }
}
