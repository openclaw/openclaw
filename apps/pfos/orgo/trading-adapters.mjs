function pseudoMetric(seed, min, max) {
  const s = Array.from(String(seed)).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const r = (s % 1000) / 1000;
  return min + r * (max - min);
}

const MT5_BRIDGE_URL = String(process.env.MT5_BRIDGE_URL ?? "").trim().replace(/\/+$/, "");
const MT5_BRIDGE_KEY = String(process.env.MT5_BRIDGE_KEY ?? "").trim();
const MT5_DRY_RUN = String(process.env.MT5_DRY_RUN ?? "1") === "1";

function normalizeReturns(payload) {
  // Accept any of:
  // - payload.returnsR = [0.5, -1.0, ...]
  // - payload.trades = [{ rMultiple: 0.8 }, { pnlR: -0.4 }, { pnlPct: 1.2 }]
  // - payload.signals = [{ r: 0.3 }, ...]
  if (Array.isArray(payload?.returnsR)) {
    return payload.returnsR.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }

  const fromObjects = (arr) =>
    arr
      .map((item) => {
        const rMultiple = Number(item?.rMultiple);
        if (Number.isFinite(rMultiple)) return rMultiple;
        const pnlR = Number(item?.pnlR ?? item?.r);
        if (Number.isFinite(pnlR)) return pnlR;
        const pnlPct = Number(item?.pnlPct);
        if (Number.isFinite(pnlPct)) return pnlPct / 100;
        return NaN;
      })
      .filter((v) => Number.isFinite(v));

  if (Array.isArray(payload?.trades)) return fromObjects(payload.trades);
  if (Array.isArray(payload?.signals)) return fromObjects(payload.signals);
  return [];
}

function computeMetricsFromReturns(returnsR) {
  const n = returnsR.length;
  if (!n) return null;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;

  for (const r of returnsR) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (r > 0) {
      wins += 1;
      grossProfit += r;
    } else if (r < 0) {
      grossLossAbs += Math.abs(r);
    }
  }

  const winRate = Number(((wins / n) * 100).toFixed(2));
  const expectancyR = Number((equity / n).toFixed(4));
  const profitFactor = grossLossAbs > 0 ? Number((grossProfit / grossLossAbs).toFixed(3)) : null;
  const maxDrawdownR = Number(maxDd.toFixed(4));
  const maxDrawdownPct = Number((maxDd * 100).toFixed(2));
  return {
    trades: n,
    winRate,
    expectancyR,
    netR: Number(equity.toFixed(4)),
    profitFactor,
    maxDrawdownR,
    maxDrawdownPct,
  };
}

function backtestTemplate(provider, payload) {
  const strategy = String(payload?.strategy ?? "baseline");
  const symbol = String(payload?.symbol ?? "BTCUSD");
  const timeframe = String(payload?.timeframe ?? "1h");
  const period = String(payload?.period ?? "180d");
  const seed = `${provider}:${strategy}:${symbol}:${timeframe}:${period}`;

  const winRate = Number(pseudoMetric(seed, 42, 68).toFixed(2));
  const profitFactor = Number(pseudoMetric(seed + "pf", 1.05, 2.1).toFixed(2));
  const maxDrawdownPct = Number(pseudoMetric(seed + "dd", 4, 22).toFixed(2));
  const expectancy = Number(pseudoMetric(seed + "exp", 0.1, 1.7).toFixed(2));

  const returns = provider === "TradingView" ? normalizeReturns(payload) : [];
  const computed = returns.length > 0 ? computeMetricsFromReturns(returns) : null;

  return {
    provider,
    mode: "backtest",
    strategy,
    symbol,
    timeframe,
    period,
    metrics:
      computed ??
      {
        winRate,
        profitFactor,
        maxDrawdownPct,
        expectancyR: expectancy,
      },
    dataSource: computed ? "tradingview-webhook-payload" : "synthetic-template",
    notes: [
      computed
        ? "Metrics computed from provided TradingView payload returns/trades/signals."
        : "Stub adapter result: replace with live API integration before production trading.",
      "Use this output for strategy compare/rank only in current scaffold.",
    ],
  };
}

function strategyTemplate(provider, payload) {
  const base = String(payload?.strategy ?? "trend-follow");
  const market = String(payload?.market ?? "crypto");
  const objective = String(payload?.objective ?? "improve risk-adjusted return");
  return {
    provider,
    mode: "strategy-development",
    strategy: base,
    market,
    objective,
    proposal: {
      entryRule: "Breakout confirmed by momentum + volume filter.",
      exitRule: "ATR-based trailing stop with structure invalidation.",
      riskRule: "Fixed fractional risk per trade with daily loss cap.",
      validationPlan: ["Out-of-sample split", "Walk-forward test", "Parameter sensitivity sweep"],
    },
    notes: [
      "Stub adapter result: logic and metrics are synthetic until provider APIs are connected.",
      "Promote only after forward-test threshold is met.",
    ],
  };
}

async function mt5BridgeCall(path, payload) {
  if (!MT5_BRIDGE_URL) {
    throw new Error("MT5_BRIDGE_URL is not configured");
  }
  const headers = { "content-type": "application/json" };
  if (MT5_BRIDGE_KEY) {
    headers.authorization = `Bearer ${MT5_BRIDGE_KEY}`;
  }
  const res = await fetch(`${MT5_BRIDGE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MT5 bridge call failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function mt5Backtest(payload) {
  if (MT5_DRY_RUN || !MT5_BRIDGE_URL) {
    return {
      ...backtestTemplate("MT5", payload),
      dataSource: "mt5-bridge-dry-run",
      notes: ["Dry run mode active or MT5 bridge not configured."],
    };
  }
  const bridge = await mt5BridgeCall("/backtest", payload);
  return {
    provider: "MT5",
    mode: "backtest",
    strategy: payload?.strategy ?? "mt5-strategy",
    symbol: payload?.symbol ?? "EURUSD",
    timeframe: payload?.timeframe ?? "15m",
    period: payload?.period ?? "180d",
    metrics: bridge?.metrics ?? bridge,
    dataSource: "mt5-bridge",
    raw: bridge,
    notes: ["Metrics from MT5 bridge integration."],
  };
}

async function mt5Strategy(payload) {
  if (MT5_DRY_RUN || !MT5_BRIDGE_URL) {
    return {
      ...strategyTemplate("MT5", payload),
      dataSource: "mt5-bridge-dry-run",
      notes: ["Dry run mode active or MT5 bridge not configured."],
    };
  }
  const bridge = await mt5BridgeCall("/strategy", payload);
  return {
    provider: "MT5",
    mode: "strategy-development",
    strategy: payload?.strategy ?? "mt5-strategy",
    market: payload?.market ?? "forex",
    objective: payload?.objective ?? "improve risk-adjusted return",
    dataSource: "mt5-bridge",
    raw: bridge,
    proposal: bridge?.proposal ?? bridge,
    notes: ["Strategy output from MT5 bridge integration."],
  };
}

export const TradingAdapters = {
  tradelocker: {
    runBacktest: (payload) => backtestTemplate("TradeLocker", payload),
    developStrategy: (payload) => strategyTemplate("TradeLocker", payload),
  },
  mt5: {
    runBacktest: mt5Backtest,
    developStrategy: mt5Strategy,
  },
  tradingview: {
    runBacktest: (payload) => backtestTemplate("TradingView", payload),
    developStrategy: (payload) => strategyTemplate("TradingView", payload),
  },
};

export function resolveTradingAdapter(providerRaw) {
  const key = String(providerRaw ?? "tradingview").toLowerCase();
  if (key === "tradelocker") return TradingAdapters.tradelocker;
  if (key === "mt5" || key === "metatrader5") return TradingAdapters.mt5;
  return TradingAdapters.tradingview;
}
