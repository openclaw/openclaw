import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

const DEFAULT_INPUT_PATH = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "capital-paper-history-replay-latest.json",
);
const DEFAULT_OUTPUT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-simulation-latest.json",
);
const DEFAULT_DMAD_TASK_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-dmad-task-latest.json",
);
const DEFAULT_PARAMS_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-params-latest.json",
);
const DEFAULT_STRATEGY_PARAMS = Object.freeze({
  volume_breakout: {
    lookbackBars: 30,
    volumeLookbackBars: 40,
    volumeZThreshold: 1.2,
    breakoutThresholdPct: 0.04,
    takeProfitPct: 0.2,
    stopLossPct: 0.12,
    maxHoldBars: 20,
  },
  vwap_reversion: {
    volumeLookbackBars: 50,
    volumeZThreshold: 0.8,
    vwapDeviationPct: 0.15,
    stopLossPct: 0.1,
    maxHoldBars: 30,
  },
});

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePrice(raw, decimal) {
  const n = asNumber(raw, NaN);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const d = Math.max(0, Math.floor(asNumber(decimal, 2)));
  const scale = 10 ** d;
  if (scale <= 1) {
    return n;
  }
  // raw quote in Capital callback often uses integer price with sDecimal scale.
  if (Math.abs(n) >= scale * 1000) {
    return n / scale;
  }
  return n;
}

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stddev(values) {
  if (values.length <= 1) {
    return 0;
  }
  const m = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rollingWindow(arr, endIndex, size) {
  const start = Math.max(0, endIndex - size + 1);
  return arr.slice(start, endIndex + 1);
}

function clampNumber(value, min, max, fallback) {
  const n = asNumber(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  return Math.floor(clampNumber(value, min, max, fallback));
}

function normalizeStrategyParams(rawOverrides) {
  const source = rawOverrides && typeof rawOverrides === "object" ? rawOverrides : {};
  const rawBreakout =
    source.volume_breakout && typeof source.volume_breakout === "object"
      ? source.volume_breakout
      : {};
  const rawVwap =
    source.vwap_reversion && typeof source.vwap_reversion === "object" ? source.vwap_reversion : {};

  return {
    volume_breakout: {
      lookbackBars: clampInt(
        rawBreakout.lookbackBars,
        10,
        120,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.lookbackBars,
      ),
      volumeLookbackBars: clampInt(
        rawBreakout.volumeLookbackBars,
        20,
        200,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.volumeLookbackBars,
      ),
      volumeZThreshold: clampNumber(
        rawBreakout.volumeZThreshold,
        0.2,
        5.0,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.volumeZThreshold,
      ),
      breakoutThresholdPct: clampNumber(
        rawBreakout.breakoutThresholdPct,
        0.01,
        1.5,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.breakoutThresholdPct,
      ),
      takeProfitPct: clampNumber(
        rawBreakout.takeProfitPct,
        0.02,
        3.0,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.takeProfitPct,
      ),
      stopLossPct: clampNumber(
        rawBreakout.stopLossPct,
        0.02,
        2.0,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.stopLossPct,
      ),
      maxHoldBars: clampInt(
        rawBreakout.maxHoldBars,
        3,
        300,
        DEFAULT_STRATEGY_PARAMS.volume_breakout.maxHoldBars,
      ),
    },
    vwap_reversion: {
      volumeLookbackBars: clampInt(
        rawVwap.volumeLookbackBars,
        20,
        200,
        DEFAULT_STRATEGY_PARAMS.vwap_reversion.volumeLookbackBars,
      ),
      volumeZThreshold: clampNumber(
        rawVwap.volumeZThreshold,
        0.2,
        5.0,
        DEFAULT_STRATEGY_PARAMS.vwap_reversion.volumeZThreshold,
      ),
      vwapDeviationPct: clampNumber(
        rawVwap.vwapDeviationPct,
        0.03,
        2.0,
        DEFAULT_STRATEGY_PARAMS.vwap_reversion.vwapDeviationPct,
      ),
      stopLossPct: clampNumber(
        rawVwap.stopLossPct,
        0.02,
        2.0,
        DEFAULT_STRATEGY_PARAMS.vwap_reversion.stopLossPct,
      ),
      maxHoldBars: clampInt(
        rawVwap.maxHoldBars,
        3,
        300,
        DEFAULT_STRATEGY_PARAMS.vwap_reversion.maxHoldBars,
      ),
    },
  };
}

function pnlStats(trades) {
  const pnls = trades.map((trade) => trade.pnlPts);
  const wins = trades.filter((trade) => trade.pnlPts > 0).length;
  const losses = trades.filter((trade) => trade.pnlPts < 0).length;
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnls) {
    running += value;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  }
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? Number((wins / trades.length).toFixed(4)) : 0,
    totalPnlPts: Number(pnls.reduce((acc, value) => acc + value, 0).toFixed(4)),
    avgPnlPts: trades.length > 0 ? Number(mean(pnls).toFixed(4)) : 0,
    maxDrawdownPts: Number(maxDrawdown.toFixed(4)),
  };
}

function runStrategyVolumeBreakout(events, config) {
  const trades = [];
  let position = null;
  const lookbackBars = Math.max(2, config.lookbackBars);
  const volumeLookbackBars = Math.max(2, config.volumeLookbackBars);
  const breakoutThreshold = config.breakoutThresholdPct / 100;
  const takeProfit = config.takeProfitPct / 100;
  const stopLoss = config.stopLossPct / 100;
  for (let i = lookbackBars; i < events.length; i += 1) {
    const current = events[i];
    if (!position) {
      const window = rollingWindow(events, i - 1, lookbackBars);
      const highs = window.map((item) => item.price);
      const lows = window.map((item) => item.price);
      const volWindow = rollingWindow(events, i - 1, volumeLookbackBars).map((item) => item.volume);
      const volMean = mean(volWindow);
      const volStd = stddev(volWindow);
      const volZ = volStd > 0 ? (current.volume - volMean) / volStd : 0;
      const upper = Math.max(...highs);
      const lower = Math.min(...lows);
      if (volZ >= config.volumeZThreshold && current.price > upper * (1 + breakoutThreshold)) {
        position = { side: "long", entry: current.price, entryIndex: i };
      } else if (
        volZ >= config.volumeZThreshold &&
        current.price < lower * (1 - breakoutThreshold)
      ) {
        position = { side: "short", entry: current.price, entryIndex: i };
      }
      continue;
    }

    const heldBars = i - position.entryIndex;
    const move =
      position.side === "long" ? current.price - position.entry : position.entry - current.price;
    const stop = move <= -position.entry * stopLoss;
    const take = move >= position.entry * takeProfit;
    const timeout = heldBars >= config.maxHoldBars;
    if (stop || take || timeout) {
      trades.push({
        strategy: "volume_breakout",
        side: position.side,
        entryPrice: position.entry,
        exitPrice: current.price,
        barsHeld: heldBars,
        pnlPts: Number(move.toFixed(4)),
      });
      position = null;
    }
  }
  return trades;
}

function runStrategyVwapReversion(events, config) {
  const trades = [];
  let position = null;
  let cumPv = 0;
  let cumVol = 0;
  const vwapDeviation = config.vwapDeviationPct / 100;
  const stopLoss = config.stopLossPct / 100;

  for (let i = 0; i < events.length; i += 1) {
    const current = events[i];
    cumPv += current.price * Math.max(1, current.volume);
    cumVol += Math.max(1, current.volume);
    const vwap = cumVol > 0 ? cumPv / cumVol : current.price;
    if (!position) {
      const volWindow = rollingWindow(events, i, config.volumeLookbackBars).map(
        (item) => item.volume,
      );
      const volMean = mean(volWindow);
      const volStd = stddev(volWindow);
      const volZ = volStd > 0 ? (current.volume - volMean) / volStd : 0;
      if (volZ >= config.volumeZThreshold && current.price < vwap * (1 - vwapDeviation)) {
        position = { side: "long", entry: current.price, entryIndex: i, anchor: vwap };
      } else if (volZ >= config.volumeZThreshold && current.price > vwap * (1 + vwapDeviation)) {
        position = { side: "short", entry: current.price, entryIndex: i, anchor: vwap };
      }
      continue;
    }

    const heldBars = i - position.entryIndex;
    const move =
      position.side === "long" ? current.price - position.entry : position.entry - current.price;
    const exitAtMean =
      position.side === "long"
        ? current.price >= position.anchor
        : current.price <= position.anchor;
    const stop = move <= -position.entry * stopLoss;
    const timeout = heldBars >= config.maxHoldBars;
    if (exitAtMean || stop || timeout) {
      trades.push({
        strategy: "vwap_reversion",
        side: position.side,
        entryPrice: position.entry,
        exitPrice: current.price,
        barsHeld: heldBars,
        pnlPts: Number(move.toFixed(4)),
      });
      position = null;
    }
  }
  return trades;
}

function distinctDates(events) {
  const set = new Set();
  for (const event of events) {
    set.add(event.date);
  }
  return [...set].sort();
}

function detectHolidayGaps(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i += 1) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`);
    const next = new Date(`${dates[i]}T00:00:00Z`);
    const days = Math.round((next - prev) / 86400000);
    if (days >= 2) {
      gaps.push({
        from: dates[i - 1],
        to: dates[i],
        gapDays: days,
        type: days >= 3 ? "long_holiday_or_weekend" : "single_holiday_or_weekend",
      });
    }
  }
  return gaps;
}

function buildDmadTask(report) {
  return {
    schema: "openclaw.capital.holiday-weekly-dmad-task.v1",
    generatedAt: report.generatedAt,
    title: "一週假日/休市週價量模擬後策略調優",
    prompt: [
      "請基於以下輸入，提出 3 個可執行且 paper-only 的策略調優建議：",
      `1) 模擬樣本事件數=${report.weeklySample.events}`,
      `2) 交易日數=${report.weeklySample.tradingDays}`,
      `3) 假日/週末缺口數=${report.weeklySample.holidayGaps}`,
      `4) 最佳策略=${report.ranking[0]?.strategy ?? "none"}，總損益=${report.ranking[0]?.totalPnlPts ?? 0}`,
      "5) 要求：不可啟用真單、不可寫 broker、需附風險閘條件（停用而非刪除 AI）。",
    ].join("\n"),
    context: {
      recommendedAction: report.recommendation.nextSafeTask,
      lossAction: report.riskPolicy.onLossAction,
      alwaysOnMode: report.alwaysOnSkills.mode,
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      paperOnly: true,
    },
  };
}

export async function runCapitalHolidayWeeklySimulation(options = {}) {
  const inputPath = path.resolve(options.inputPath || DEFAULT_INPUT_PATH);
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
  const dmadTaskPath = path.resolve(options.dmadTaskPath || DEFAULT_DMAD_TASK_PATH);
  const paramsPath = path.resolve(options.paramsPath || DEFAULT_PARAMS_PATH);
  const lookbackDays = Math.max(3, Math.min(14, Math.floor(asNumber(options.lookbackDays, 7))));
  const rawParams = await readJsonIfExists(paramsPath);
  const strategyParams = normalizeStrategyParams(rawParams?.strategies ?? rawParams);

  const replay = await readJson(inputPath);
  const rows = Array.isArray(replay.replayRows) ? replay.replayRows : [];
  const normalized = rows
    .map((row) => {
      const receivedAt = String(row.receivedAt || "");
      const ts = new Date(receivedAt);
      const bid = normalizePrice(row?.spread?.bid, row.decimal);
      const ask = normalizePrice(row?.spread?.ask, row.decimal);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const fallbackClose = normalizePrice(row?.frame?.close, row.decimal);
      const price = mid > 0 ? mid : fallbackClose;
      return {
        ts,
        receivedAt,
        date: receivedAt.slice(0, 10),
        symbol: String(row.stockNo || ""),
        price,
        volume: Math.max(0, asNumber(row.volume, 0)),
      };
    })
    .filter((item) => Number.isFinite(item.ts.getTime()) && item.price > 0 && item.volume >= 0)
    .sort((a, b) => a.ts - b.ts);

  if (!normalized.length) {
    const emptyReport = {
      schema: "openclaw.capital.holiday-weekly-simulation.v1",
      generatedAt: new Date().toISOString(),
      status: "blocked_no_events",
      reason: "no_valid_replay_rows",
      inputPath,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      nextSafeTask: "先確認 replayRows 有效資料，再重跑 holiday weekly simulation。",
    };
    if (options.writeState === true) {
      await writeJson(outputPath, emptyReport);
    }
    return { report: emptyReport, outputPath, dmadTaskPath };
  }

  const lastTs = normalized[normalized.length - 1].ts.getTime();
  const lowerTs = lastTs - lookbackDays * 86400000;
  const weekEvents = normalized.filter((item) => item.ts.getTime() >= lowerTs);
  const weekDates = distinctDates(weekEvents);
  const gaps = detectHolidayGaps(weekDates);

  const breakoutTrades = runStrategyVolumeBreakout(weekEvents, strategyParams.volume_breakout);
  const vwapTrades = runStrategyVwapReversion(weekEvents, strategyParams.vwap_reversion);
  const breakoutStats = pnlStats(breakoutTrades);
  const vwapStats = pnlStats(vwapTrades);

  const ranking = [
    { strategy: "volume_breakout", ...breakoutStats },
    { strategy: "vwap_reversion", ...vwapStats },
  ].sort((a, b) => b.totalPnlPts - a.totalPnlPts);

  const allPnl = [...breakoutTrades, ...vwapTrades].map((trade) => trade.pnlPts);
  const hardLoss = allPnl.length > 0 ? Math.min(...allPnl) : 0;
  const guaranteedProfit = false;

  const report = {
    schema: "openclaw.capital.holiday-weekly-simulation.v1",
    generatedAt: new Date().toISOString(),
    status: "completed",
    mode: "paper_only_weekly_holiday_analysis",
    inputPath,
    lookbackDays,
    weeklySample: {
      events: weekEvents.length,
      tradingDays: weekDates.length,
      holidayGaps: gaps.length,
      holidayGapDetails: gaps,
      symbols: [...new Set(weekEvents.map((item) => item.symbol))].slice(0, 20),
      from: new Date(lowerTs).toISOString(),
      to: new Date(lastTs).toISOString(),
    },
    parameterTuning: {
      paramsPath,
      overridesLoaded: rawParams !== null,
      overridesSchema:
        rawParams && typeof rawParams === "object" && typeof rawParams.schema === "string"
          ? rawParams.schema
          : "",
    },
    ranking,
    strategies: {
      volume_breakout: {
        config: strategyParams.volume_breakout,
        stats: breakoutStats,
      },
      vwap_reversion: {
        config: strategyParams.vwap_reversion,
        stats: vwapStats,
      },
    },
    absoluteProfitBehavior: {
      guaranteed: guaranteedProfit,
      reason: "單週樣本與市場噪音下無法保證絕對獲利，只能以機率優勢與風險閘執行。",
    },
    riskPolicy: {
      onLossAction: "disable_all_ai_strategies_and_enter_quarantine",
      destructiveDeleteEnabled: false,
      triggerRules: {
        weeklyPnlFloorPts: -100,
        maxConsecutiveLosses: 5,
        singleTradeHardLossPts: Number(hardLoss.toFixed(4)),
      },
      comment: "虧損觸發時採停用/隔離，不做不可逆刪除。",
    },
    alwaysOnSkills: {
      mode: "7x24",
      runtime: "paper_monitoring_only",
      requiredLoops: [
        "quote freshness monitor",
        "session/holiday detector",
        "strategy simulation rerun",
        "dmad learning task exporter",
      ],
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      readOnly: true,
    },
    recommendation: {
      nextSafeTask:
        "將本報告的 DMAD 任務餵給 dmad-run-test（paper-only），比較兩策略參數並回寫到 openclaw-capital-holiday-weekly-params-latest.json。",
    },
  };

  const dmadTask = buildDmadTask(report);

  if (options.writeState === true) {
    await writeJson(outputPath, report);
    await writeJson(dmadTaskPath, dmadTask);
  }

  return { report, outputPath, dmadTaskPath, dmadTask };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalHolidayWeeklySimulation({
    inputPath: argValue("--input", DEFAULT_INPUT_PATH),
    outputPath: argValue("--output", DEFAULT_OUTPUT_PATH),
    dmadTaskPath: argValue("--dmad-task", DEFAULT_DMAD_TASK_PATH),
    paramsPath: argValue("--params", DEFAULT_PARAMS_PATH),
    lookbackDays: asNumber(argValue("--lookback-days", "7"), 7),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital holiday weekly simulation",
        `status=${result.report.status}`,
        `events=${result.report.weeklySample?.events ?? 0}`,
        `tradingDays=${result.report.weeklySample?.tradingDays ?? 0}`,
        `holidayGaps=${result.report.weeklySample?.holidayGaps ?? 0}`,
        `bestStrategy=${result.report.ranking?.[0]?.strategy ?? "none"}`,
        `bestPnlPts=${result.report.ranking?.[0]?.totalPnlPts ?? 0}`,
        "live/write/order=OFF",
      ].join("\n") + "\n",
    );
  }
}
