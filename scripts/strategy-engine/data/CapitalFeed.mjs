/**
 * CapitalFeed.mjs
 * 從群益 CapitalHftService state 檔案讀取真實報價
 *
 * 資料來源：
 *   capital_quote_events.jsonl  — tick 歷史事件日誌（累積）
 *   capital_latest_quote_event.json — 最新一筆 tick（即時）
 *   latest_quote_state.json         — 各商品最新報價快照
 *
 * 主要功能：
 *   readTicks(symbol, opts)     → 讀取原始 tick 陣列
 *   buildBars(ticks, intervalMs) → 聚合為 OHLCV K 棒
 *   fetchBars(symbol, opts)     → 一步完成（讀 tick + 聚合）
 *   fetchLatest(symbol)         → 最新報價快照
 */
import { existsSync, readFileSync, createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// ── State 路徑 ────────────────────────────────────────────────────
const STATE_DIR = process.env.CAPITAL_HFT_STATE_DIR ?? "D:\\群益及元大API\\CapitalHftService";
const STATE_SUBDIR = path.join(STATE_DIR, "state");
const EVENTS_LOG = path.join(STATE_SUBDIR, "capital_quote_events.jsonl");
const LATEST_EVT = path.join(STATE_DIR, "capital_latest_quote_event.json");
const LATEST_STA = path.join(STATE_DIR, "state", "latest_quote_state.json");

// ── 商品 decimal 對照（避免除錯找不到 decimal 欄位時用預設）────
const DEFAULT_DECIMAL = { TX00: 2, TX00AM: 2, MTX00AM: 2, XI00: 2, SP0000AM: 2 };

/**
 * 將群益報價代碼轉為系統 instrument 名
 * TX00 / TX00AM → TX  ; SP0000AM → ES  ; MTX00AM → MX
 */
export const CAPITAL_SYMBOL_MAP = {
  TX00: "TX",
  TX00AM: "TX",
  MTX00AM: "MX",
  MXFFX999: "MX",
  XI00: "XI",
  TX06: "TX6",
  TX06AM: "TX6",
  TE00: "TE",
  XE00: "XE",
  TF00: "TF",
  SP0000AM: "ES_CF", // S&P500近月（群益）
  XE0000AM: "EU", // 歐元
  XA0000AM: "AU", // 澳幣
  XB0000AM: "BP", // 英鎊
  XJ0000AM: "JY", // 日圓
};

/** 反查：instrument → 群益代碼陣列 */
export const INSTRUMENT_TO_CAPITAL = {};
for (const [cap, inst] of Object.entries(CAPITAL_SYMBOL_MAP)) {
  if (!INSTRUMENT_TO_CAPITAL[inst]) {
    INSTRUMENT_TO_CAPITAL[inst] = [];
  }
  INSTRUMENT_TO_CAPITAL[inst].push(cap);
}

// ────────────────────────────────────────────────────────────────────
// 1. 讀取原始 tick（從 capital_quote_events.jsonl）
// ────────────────────────────────────────────────────────────────────
/**
 * 從 capital_quote_events.jsonl 讀取指定商品的 tick
 * @param {string|string[]} symbols  群益代碼（'TX00'）或陣列（['TX00','TX00AM']）
 * @param {object} opts
 * @param {string} [opts.since]   ISO 時間字串，只讀此時間之後的資料
 * @param {string} [opts.until]   ISO 時間字串，只讀此時間之前的資料
 * @param {number} [opts.limit]   最多回傳幾筆 tick
 * @returns {Promise<Array<{time, price, qty, bid, ask, symbol}>>}
 */
export async function readTicks(symbols, { since, until, limit } = {}) {
  if (!existsSync(EVENTS_LOG)) {
    throw new Error(`Capital event log 不存在: ${EVENTS_LOG}`);
  }

  const symSet = new Set(Array.isArray(symbols) ? symbols : [symbols]);
  const sinceTs = since ? new Date(since).getTime() : 0;
  const untilTs = until ? new Date(until).getTime() : Infinity;
  const ticks = [];

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(EVENTS_LOG, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (limit && ticks.length >= limit) {
        rl.close();
        return;
      }
      if (!line.trim()) {
        return;
      }

      try {
        const ev = JSON.parse(line);
        if (!symSet.has(ev.stockNo)) {
          return;
        }

        // 只取 tick 事件
        if (!ev.eventSource?.includes("TicksLONG") && !ev.eventSource?.includes("QuoteLONG")) {
          return;
        }

        const ts = new Date(ev.receivedAt).getTime();
        if (ts < sinceTs || ts > untilTs) {
          return;
        }

        const dec = Number.parseInt(ev.decimal ?? DEFAULT_DECIMAL[ev.stockNo] ?? 2, 10);
        const factor = Number.isNaN(dec) ? 100 : 10 ** dec;

        // 部分商品（SP0000AM 等）close 欄位恆為 "0"，改用 bid 作為成交價
        const rawClose = Number.parseFloat(ev.close ?? 0);
        const rawBid = Number.parseFloat(ev.bid ?? 0);
        const rawPrice = rawClose > 0 ? rawClose : rawBid;
        const price = rawPrice / factor;
        if (!price || price <= 0 || !Number.isFinite(price)) {
          return;
        }

        ticks.push({
          time: ev.receivedAt,
          ts,
          price,
          bid: rawBid > 0 ? rawBid / factor : price,
          ask: Number.parseFloat(ev.ask ?? 0) > 0 ? Number.parseFloat(ev.ask) / factor : price,
          qty: Number.parseInt(ev.qty ?? 1, 10),
          symbol: ev.stockNo,
          name: ev.stockName ?? "",
        });
      } catch {
        /* 跳過損壞行 */
      }
    });

    rl.on("close", () => resolve(ticks));
    rl.on("error", (e) => reject(e));
  });
}

// ────────────────────────────────────────────────────────────────────
// 2. 聚合 tick → OHLCV K 棒
// ────────────────────────────────────────────────────────────────────
/**
 * 將 tick 陣列聚合為 OHLCV bar
 * @param {Array}   ticks       readTicks() 的輸出
 * @param {number}  intervalMs  K 棒週期（毫秒）：60000=1分, 300000=5分, 3600000=1小時
 * @returns {Array<{time, open, high, low, close, volume, ticks}>}
 */
export function buildBars(ticks, intervalMs = 60_000) {
  if (!ticks.length) {
    return [];
  }

  // 依時間排序
  const sorted = [...ticks].toSorted((a, b) => a.ts - b.ts);

  const bars = [];
  let bar = null;
  let barEnd = 0;

  for (const t of sorted) {
    // 新 bar 開始
    if (!bar || t.ts >= barEnd) {
      if (bar) {
        bars.push(bar);
      }
      const barStart = Math.floor(t.ts / intervalMs) * intervalMs;
      barEnd = barStart + intervalMs;
      bar = {
        time: new Date(barStart).toISOString(),
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: 0,
        ticks: 0,
      };
    }
    bar.high = Math.max(bar.high, t.price);
    bar.low = Math.min(bar.low, t.price);
    bar.close = t.price;
    bar.volume += t.qty;
    bar.ticks += 1;
  }
  if (bar && bar.ticks > 0) {
    bars.push(bar);
  }

  return bars;
}

// ────────────────────────────────────────────────────────────────────
// 3. 一步取得 K 棒
// ────────────────────────────────────────────────────────────────────
/**
 * 讀取群益 tick 並聚合為 OHLCV K 棒
 * @param {string|string[]} symbols    群益代碼（'TX00'）或別名陣列
 * @param {object}          opts
 * @param {number}  opts.intervalMs    K 棒週期毫秒（預設 60000=1分鐘）
 * @param {string}  [opts.interval]    '1m'|'5m'|'15m'|'30m'|'1h'|'1d'（與 intervalMs 擇一）
 * @param {string}  [opts.since]       只取此時間後
 * @param {string}  [opts.until]       只取此時間前
 * @returns {Promise<Array<OhlcvBar>>}
 */
export async function fetchBars(symbols, opts = {}) {
  const intervalMs = opts.intervalMs ?? _parseInterval(opts.interval ?? "1m");
  const ticks = await readTicks(symbols, opts);
  return buildBars(ticks, intervalMs);
}

// ────────────────────────────────────────────────────────────────────
// 4. 即時報價快照
// ────────────────────────────────────────────────────────────────────
/**
 * 取得最新報價（從 capital_latest_quote_event.json）
 */
export function fetchLatest(symbol = null) {
  if (!existsSync(LATEST_EVT)) {
    return null;
  }
  try {
    const ev = JSON.parse(readFileSync(LATEST_EVT, "utf-8"));
    if (symbol && ev.stockNo !== symbol) {
      return null;
    }
    const dec = Number.parseInt(ev.decimal ?? 2, 10);
    const factor = 10 ** dec;
    return {
      symbol: ev.stockNo,
      name: ev.stockName,
      price: Number.parseFloat(ev.close) / factor,
      bid: Number.parseFloat(ev.bid) / factor,
      ask: Number.parseFloat(ev.ask) / factor,
      qty: Number.parseInt(ev.qty, 10),
      time: ev.receivedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 列印可用商品清單（從 capital_quote_events.jsonl 統計）
 */
export async function listSymbols() {
  if (!existsSync(EVENTS_LOG)) {
    return {};
  }
  const counts = {};
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(EVENTS_LOG), crlfDelay: Infinity });
    rl.on("line", (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.stockNo) {
          counts[ev.stockNo] = (counts[ev.stockNo] ?? 0) + 1;
        }
      } catch {}
    });
    rl.on("close", () => resolve(counts));
  });
}

// ── 私有：解析 interval 字串 ──────────────────────────────────────
function _parseInterval(s) {
  const map = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  return map[s] ?? 60_000;
}
