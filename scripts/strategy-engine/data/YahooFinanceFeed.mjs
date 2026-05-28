/**
 * YahooFinanceFeed.mjs
 * 從 Yahoo Finance v8 API 免費抓取 OHLCV 歷史行情
 * 支援本地快取（避免反覆下載）、多商品批量拉取
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Yahoo Finance 商品代碼對照（Yahoo 使用 =F 後綴表示期貨連續合約）
export const YAHOO_SYMBOLS = {
  // 美股指數期貨
  ES: "ES=F",
  NQ: "NQ=F",
  YM: "YM=F",
  RTY: "RTY=F",
  MES: "MES=F",
  MNQ: "MNQ=F",
  // 商品期貨
  GC: "GC=F",
  SI: "SI=F",
  CL: "CL=F",
  NG: "NG=F",
  RB: "RB=F",
  // 債券
  ZB: "ZB=F",
  ZN: "ZN=F",
  ZF: "ZF=F",
  // 外匯（連續）
  "6E": "6E=F",
  "6J": "6J=F",
  "6B": "6B=F",
  // 股票 ETF（用於台指、港股替代）
  SPY: "SPY",
  QQQ: "QQQ",
  GLD: "GLD",
  USO: "USO",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/**
 * 從 Yahoo Finance 抓取 OHLCV bar
 * @param {string} symbol   OpenClaw 商品代碼（ES / NQ / GC …）或 Yahoo 原始代碼（ES=F / SPY）
 * @param {object} opts
 * @param {string} opts.interval   K 棒週期：'1m'|'5m'|'15m'|'1h'|'1d'|'1wk'|'1mo'（預設 '1d'）
 * @param {string} opts.range      時間範圍：'1d'|'5d'|'1mo'|'3mo'|'6mo'|'1y'|'2y'|'5y'（預設 '1y'）
 * @param {string} [opts.cacheDir] 快取目錄（預設 'cache/yahoo'）；設為 null 停用快取
 * @param {number} [opts.cacheTtlMs] 快取有效期（預設 3600000 = 1 小時）
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
export async function fetchBars(symbol, { interval, range, cacheDir, cacheTtlMs } = {}) {
  const resolvedInterval = interval ?? "1d";
  const resolvedRange = range ?? "1y";
  const resolvedCacheDir = cacheDir === undefined ? path.join("cache", "yahoo") : cacheDir;
  const resolvedCacheTtlMs = cacheTtlMs ?? 3_600_000;

  // 解析 Yahoo 代碼
  const yahooSym = YAHOO_SYMBOLS[symbol] ?? symbol;
  const encodedSym = encodeURIComponent(yahooSym);

  // ── 快取 ──────────────────────────────────────────────
  let cacheFile = null;
  if (resolvedCacheDir) {
    if (!existsSync(resolvedCacheDir)) {
      mkdirSync(resolvedCacheDir, { recursive: true });
    }
    const safeName = yahooSym.replace(/[^a-zA-Z0-9]/g, "_");
    cacheFile = path.join(
      resolvedCacheDir,
      `${safeName}_${resolvedInterval}_${resolvedRange}.json`,
    );

    if (existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
        if (Date.now() - cached.fetchedAt < resolvedCacheTtlMs) {
          return cached.bars;
        }
      } catch {
        /* 快取損壞，重新下載 */
      }
    }
  }

  // ── 下載 ──────────────────────────────────────────────
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSym}?interval=${resolvedInterval}&range=${resolvedRange}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`Yahoo Finance HTTP ${res.status} for ${yahooSym}`);
  }

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) {
    const errMsg = json.chart?.error?.description ?? "no data";
    throw new Error(`Yahoo Finance 無資料: ${yahooSym} → ${errMsg}`);
  }

  const { timestamp } = result;
  const { open, high, low, close, volume } = result.indicators.quote[0];
  const adjClose = result.indicators.adjclose?.[0]?.adjclose;

  const bars = [];
  for (let i = 0; i < timestamp.length; i++) {
    if (close[i] == null) {
      continue;
    } // 跳過空值（停市、缺漏）
    bars.push({
      time: new Date(timestamp[i] * 1000).toISOString(),
      open: open[i] ?? close[i],
      high: high[i] ?? close[i],
      low: low[i] ?? close[i],
      close: close[i],
      volume: volume[i] ?? 0,
      adjClose: adjClose?.[i] ?? close[i],
    });
  }

  // ── 存快取 ────────────────────────────────────────────
  if (cacheFile) {
    try {
      writeFileSync(
        cacheFile,
        JSON.stringify({
          fetchedAt: Date.now(),
          symbol: yahooSym,
          interval: resolvedInterval,
          range: resolvedRange,
          bars,
        }),
      );
    } catch {
      /* 快取寫入失敗不影響主流程 */
    }
  }

  return bars;
}

/**
 * 批量抓取多商品
 * @param {string[]} symbols
 * @param {object}   opts   同 fetchBars opts
 * @returns {Promise<Record<string, Array>>}   { ES: [...], NQ: [...], ... }
 */
export async function fetchMulti(symbols, opts = {}) {
  const results = await Promise.allSettled(
    symbols.map((sym) => fetchBars(sym, opts).then((bars) => ({ sym, bars }))),
  );

  const out = {};
  for (const r of results) {
    if (r.status === "fulfilled") {
      out[r.value.sym] = r.value.bars;
    } else {
      console.warn(`[YahooFeed] ⚠️  ${r.reason?.message ?? r.reason}`);
    }
  }
  return out;
}

/**
 * 取得當前報價（從 meta.regularMarketPrice）
 * @param {string} symbol
 * @returns {Promise<{symbol, price, time}>}
 */
export async function fetchQuote(symbol) {
  const yahooSym = YAHOO_SYMBOLS[symbol] ?? symbol;
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`,
    { headers: { "User-Agent": UA } },
  );
  const json = await res.json();
  const meta = json.chart?.result?.[0]?.meta;
  return {
    symbol: yahooSym,
    price: meta?.regularMarketPrice,
    prevClose: meta?.chartPreviousClose,
    time: new Date(meta?.regularMarketTime * 1000).toISOString(),
  };
}
