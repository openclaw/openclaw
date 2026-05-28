import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  EmaTrendStrategy,
  OrbStrategy,
  VwapMeanRevertStrategy,
} from "./openclaw-capital-strategy-engine.mjs";

const SCHEMA = "openclaw.capital.qmd-walk-forward-gate.v1";
const DEFAULT_MAX_DAYS = 260;
const DEFAULT_FOLDS = 5;
const DEFAULT_MIN_TEST_TRADES = 30;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, text, "utf8");
  await fsp.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeBar(raw) {
  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  if (
    raw.symbol !== "TXF" ||
    raw.inDaySession !== true ||
    !raw.date ||
    !raw.time ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return null;
  }
  return {
    symbol: "TXF",
    date: raw.date,
    hhmm: raw.time,
    barKey: `${raw.date}_${raw.time}`,
    inDaySession: true,
    open,
    high,
    low,
    close,
    bid: close,
    ask: close,
    volume: Number(raw.volume ?? 0),
    ticks: 1,
    tsOpen: `${raw.date}T${raw.time}:00+08:00`,
    tsClose: `${raw.date}T${raw.time}:59+08:00`,
  };
}

async function loadRecentDayBars({ barsPath, maxDays }) {
  const dayQueue = [];
  let currentDate = "";
  let currentBars = [];
  let rowsScanned = 0;
  let validBars = 0;

  const input = fs.createReadStream(barsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  function flushDay() {
    if (currentDate && currentBars.length > 0) {
      dayQueue.push({ date: currentDate, bars: currentBars });
      while (dayQueue.length > maxDays) {
        dayQueue.shift();
      }
    }
  }

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    rowsScanned++;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    const bar = normalizeBar(raw);
    if (!bar) {
      continue;
    }
    validBars++;
    if (bar.date !== currentDate) {
      flushDay();
      currentDate = bar.date;
      currentBars = [];
    }
    currentBars.push(bar);
  }
  flushDay();

  return {
    rowsScanned,
    validBars,
    days: dayQueue,
  };
}

function simulateTrade(signal, futureBars) {
  const entry = Number(signal.entryPrice);
  const stop = Number(signal.stopPrice);
  const target = Number(signal.targetPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
    return null;
  }
  const direction = signal.direction === "short" ? "short" : "long";
  const riskPts = Math.abs(entry - stop);
  const rewardPts = Math.abs(target - entry);
  if (riskPts <= 0 || rewardPts <= 0) {
    return null;
  }
  for (const bar of futureBars) {
    if (direction === "long") {
      if (bar.low <= stop) {
        return { pnlPts: -riskPts, outcome: "stop", exitPrice: stop };
      }
      if (bar.high >= target) {
        return { pnlPts: rewardPts, outcome: "target", exitPrice: target };
      }
    } else {
      if (bar.high >= stop) {
        return { pnlPts: -riskPts, outcome: "stop", exitPrice: stop };
      }
      if (bar.low <= target) {
        return { pnlPts: rewardPts, outcome: "target", exitPrice: target };
      }
    }
  }
  const last = futureBars[futureBars.length - 1];
  if (!last) {
    return { pnlPts: 0, outcome: "no_future_bar", exitPrice: entry };
  }
  const pnlPts = direction === "long" ? last.close - entry : entry - last.close;
  return { pnlPts, outcome: "session_close", exitPrice: last.close };
}

function simulateDay(day) {
  const orb = new OrbStrategy({ orbMinutes: 30, riskRewardRatio: 1.5, stopPct: 0.5 });
  const ema = new EmaTrendStrategy({ fastPeriod: 5, slowPeriod: 20 });
  const vwap = new VwapMeanRevertStrategy({ deviationMult: 1.5 });
  const seenBars = [];
  const trades = [];
  const maxTradesPerDay = 3;

  for (let index = 0; index < day.bars.length && trades.length < maxTradesPerDay; index++) {
    const bar = day.bars[index];
    seenBars.push(bar);
    const signals = [orb.onBar(bar), ema.onBars(seenBars), vwap.onBars(seenBars)].filter(Boolean);

    for (const signal of signals) {
      if (trades.length >= maxTradesPerDay) {
        break;
      }
      const result = simulateTrade(signal, day.bars.slice(index + 1));
      if (!result) {
        continue;
      }
      trades.push({
        date: day.date,
        strategy: signal.type ?? "unknown",
        direction: signal.direction ?? "",
        entryPrice: round(Number(signal.entryPrice), 2),
        stopPrice: round(Number(signal.stopPrice), 2),
        targetPrice: round(Number(signal.targetPrice), 2),
        pnlPts: round(result.pnlPts, 4),
        outcome: result.outcome,
        signalBar: signal.barSnapshot?.barKey ?? bar.barKey,
      });
    }
  }
  return trades;
}

function summarizeTrades(trades) {
  let equity = 0;
  let peak = 0;
  let maxDrawdownPts = 0;
  const byStrategy = {};
  for (const trade of trades) {
    equity += trade.pnlPts;
    peak = Math.max(peak, equity);
    maxDrawdownPts = Math.max(maxDrawdownPts, peak - equity);
    byStrategy[trade.strategy] ??= { trades: 0, wins: 0, pnlPts: 0 };
    byStrategy[trade.strategy].trades += 1;
    byStrategy[trade.strategy].wins += trade.pnlPts > 0 ? 1 : 0;
    byStrategy[trade.strategy].pnlPts += trade.pnlPts;
  }
  const wins = trades.filter((trade) => trade.pnlPts > 0).length;
  return {
    trades: trades.length,
    wins,
    losses: trades.filter((trade) => trade.pnlPts < 0).length,
    winRate: trades.length > 0 ? round(wins / trades.length) : 0,
    totalPnlPts: round(equity),
    avgPnlPts: trades.length > 0 ? round(equity / trades.length) : 0,
    maxDrawdownPts: round(maxDrawdownPts),
    byStrategy: Object.fromEntries(
      Object.entries(byStrategy).map(([strategy, stats]) => [
        strategy,
        {
          trades: stats.trades,
          winRate: stats.trades > 0 ? round(stats.wins / stats.trades) : 0,
          pnlPts: round(stats.pnlPts),
        },
      ]),
    ),
  };
}

function buildWalkForward(days, folds) {
  const foldSize = Math.max(1, Math.floor(days.length / (folds + 1)));
  const results = [];
  for (let foldIndex = 0; foldIndex < folds; foldIndex++) {
    const trainStart = 0;
    const trainEnd = foldSize * (foldIndex + 1);
    const testStart = trainEnd;
    const testEnd =
      foldIndex === folds - 1 ? days.length : Math.min(days.length, testStart + foldSize);
    if (testStart >= days.length) {
      break;
    }
    const trainDays = days.slice(trainStart, trainEnd);
    const testDays = days.slice(testStart, testEnd);
    const trainTrades = trainDays.flatMap(simulateDay);
    const testTrades = testDays.flatMap(simulateDay);
    results.push({
      fold: foldIndex + 1,
      trainRange: {
        from: trainDays[0]?.date ?? "",
        to: trainDays[trainDays.length - 1]?.date ?? "",
        days: trainDays.length,
      },
      testRange: {
        from: testDays[0]?.date ?? "",
        to: testDays[testDays.length - 1]?.date ?? "",
        days: testDays.length,
      },
      train: summarizeTrades(trainTrades),
      test: summarizeTrades(testTrades),
    });
  }
  return results;
}

function toMarkdown(report) {
  const foldRows = report.folds.map(
    (fold) =>
      `| ${fold.fold} | ${fold.trainRange.from}..${fold.trainRange.to} | ${fold.testRange.from}..${fold.testRange.to} | ${fold.test.trades} | ${fold.test.winRate} | ${fold.test.totalPnlPts} | ${fold.test.maxDrawdownPts} |`,
  );
  return [
    "# Capital QMD Walk-Forward Gate",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- recommendation: ${report.recommendation}`,
    `- barsPath: ${report.inputs.barsPath}`,
    `- usedDays: ${report.inputs.usedDays}`,
    `- rowsScanned: ${report.inputs.rowsScanned}`,
    `- totalTestTrades: ${report.summary.totalTestTrades}`,
    `- positiveFoldRate: ${report.summary.positiveFoldRate}`,
    `- totalTestPnlPts: ${report.summary.totalTestPnlPts}`,
    `- maxTestDrawdownPts: ${report.summary.maxTestDrawdownPts}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    "",
    "## Folds",
    "",
    "| Fold | Train | Test | Trades | WinRate | TestPnlPts | MaxDDPts |",
    "|---:|---|---|---:|---:|---:|---:|",
    ...foldRows,
    "",
    "## Next task",
    "",
    report.nextSafeTask,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    maxDays: DEFAULT_MAX_DAYS,
    folds: DEFAULT_FOLDS,
    minTestTrades: DEFAULT_MIN_TEST_TRADES,
    writeState: false,
    json: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--bars") {
      options.barsPath = argv[++index];
    } else if (arg === "--days") {
      options.maxDays = Number(argv[++index]);
    } else if (arg === "--folds") {
      options.folds = Number(argv[++index]);
    } else if (arg === "--min-test-trades") {
      options.minTestTrades = Number(argv[++index]);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    }
  }
  return options;
}

export async function runCapitalQmdWalkForwardGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const riskControls = await readJsonIfExists(
    path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json"),
  );
  const barsPath = path.resolve(
    options.barsPath ?? path.join(repoRoot, ".openclaw", "bars", "TXF-1m.jsonl"),
  );
  const maxDays = Number.isFinite(options.maxDays) ? Math.trunc(options.maxDays) : DEFAULT_MAX_DAYS;
  const folds = Number.isFinite(options.folds) ? Math.trunc(options.folds) : DEFAULT_FOLDS;
  const minTestTrades = Number.isFinite(options.minTestTrades)
    ? Math.trunc(options.minTestTrades)
    : Number(riskControls?.minWalkForwardTestTrades ?? DEFAULT_MIN_TEST_TRADES);
  const maxDrawdownLimit = Number(riskControls?.maxWalkForwardDrawdownPts ?? 1500);
  const minPositiveFoldRate = Number(riskControls?.minWalkForwardPositiveFoldRate ?? 0.6);
  const generatedAt = new Date().toISOString();

  const sourceExists = await fsp.stat(barsPath).then(
    (stat) => stat.isFile(),
    () => false,
  );
  if (!sourceExists) {
    return {
      schema: SCHEMA,
      generatedAt,
      status: "blocked_no_qmd_bars",
      recommendation: "import_qmd_first",
      inputs: { repoRoot, barsPath, usedDays: 0, rowsScanned: 0 },
      safety: {
        liveTradingEnabled: false,
        writeBrokerOrders: false,
        brokerOrderPathEnabled: false,
        sentOrder: false,
      },
      summary: {
        totalTestTrades: 0,
        positiveFoldRate: 0,
        totalTestPnlPts: 0,
        maxTestDrawdownPts: 0,
      },
      folds: [],
      nextSafeTask:
        "先執行 pnpm qmd:combine 或 capital-hft:qmd:import 建立 TXF-1m.jsonl，再重跑 walk-forward gate。",
    };
  }

  const loaded = await loadRecentDayBars({ barsPath, maxDays });
  const walkForwardFolds = buildWalkForward(loaded.days, folds);
  const totalTestTrades = walkForwardFolds.reduce((sum, fold) => sum + fold.test.trades, 0);
  const totalTestPnlPts = round(
    walkForwardFolds.reduce((sum, fold) => sum + fold.test.totalPnlPts, 0),
  );
  const positiveFolds = walkForwardFolds.filter((fold) => fold.test.totalPnlPts > 0).length;
  const positiveFoldRate =
    walkForwardFolds.length > 0 ? round(positiveFolds / walkForwardFolds.length) : 0;
  const maxTestDrawdownPts = round(
    Math.max(0, ...walkForwardFolds.map((fold) => fold.test.maxDrawdownPts)),
  );
  const aggregateTest = summarizeTrades(
    walkForwardFolds.flatMap(() => {
      // The fold summaries are enough for gate status; avoid persisting all trades.
      return [];
    }),
  );
  const status =
    loaded.days.length < 120
      ? "blocked_insufficient_history_days"
      : totalTestTrades < minTestTrades
        ? "blocked_insufficient_test_trades"
        : totalTestPnlPts <= 0 ||
            positiveFoldRate < minPositiveFoldRate ||
            maxTestDrawdownPts > maxDrawdownLimit
          ? "blocked_walk_forward_failed"
          : "passed";
  const recommendation =
    status === "passed" ? "walk_forward_clear_paper_only" : "paper_only_improve_strategy";
  const report = {
    schema: SCHEMA,
    generatedAt,
    status,
    recommendation,
    inputs: {
      repoRoot,
      barsPath,
      maxDays,
      folds,
      minTestTrades,
      maxDrawdownLimit,
      minPositiveFoldRate,
      rowsScanned: loaded.rowsScanned,
      validBars: loaded.validBars,
      usedDays: loaded.days.length,
      dateRange: {
        from: loaded.days[0]?.date ?? "",
        to: loaded.days[loaded.days.length - 1]?.date ?? "",
      },
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerOrderPathEnabled: false,
      sentOrder: false,
      loginAttempted: false,
      readOnlyHistoricalReplayOnly: true,
    },
    summary: {
      totalTestTrades,
      positiveFoldRate,
      totalTestPnlPts,
      maxTestDrawdownPts,
      aggregateTest,
    },
    folds: walkForwardFolds,
    nextSafeTask:
      status === "passed"
        ? "walk-forward gate 已通過；下一步處理 PreTradeRiskGate / SEMI approval / latency-gap 主流程接線。"
        : "walk-forward gate 未通過；下一步調整策略風控或加入 QMD 參數掃描，不可升真單。",
  };

  if (options.writeState || options.check) {
    await writeJsonWithSha(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-qmd-walk-forward-gate-latest.json",
      ),
      report,
    );
    await writeTextWithSha(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-qmd-walk-forward-gate-latest.md",
      ),
      `${toMarkdown(report)}\n`,
    );
    await writeTextWithSha(
      path.join(repoRoot, "docs", "automation", "capital-api-qmd-walk-forward-gate.md"),
      `${toMarkdown(report)}\n`,
    );
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalQmdWalkForwardGate({
    repoRoot: process.cwd(),
    barsPath: options.barsPath,
    maxDays: options.maxDays,
    folds: options.folds,
    minTestTrades: options.minTestTrades,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${toMarkdown(report)}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
