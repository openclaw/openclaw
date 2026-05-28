/**
 * OsQuoteFeed.mjs
 * 從群益 HFT Service 讀取海外商品（OS）報價
 *
 * 資料來源（均在 D:\群益及元大API\CapitalHftService\ 下）：
 *   state/os_latest_quote_event.json    — 最新一筆 OS tick（持續即時更新）
 *   logs/YYYYMMDD.log                   — 每日完整 OS 報價串流（text log，~3M 行/日）
 *
 * 主要 API：
 *   fetchOsLatest(symbol?)              → 最新 OS 報價快照（OS 代碼或 instrument 名）
 *   readOsLogTicks(symbols, opts)       → 從 log 讀取 tick 陣列
 *   buildOsLogBars(ticks, intervalMs)   → tick 聚合成 OHLCV bars
 *   fetchOsLogBars(symbols, opts)       → 一步完成（讀 + 聚合）
 *   OS_SYMBOL_MAP                       → Capital OS 代碼 → instrument 對照表
 *   INSTRUMENT_TO_OS                    → instrument → Capital 代碼陣列（反查）
 *
 * Log 行格式：
 *   [YYYY-MM-DD HH:mm:ss.fff] [os-event] QuoteLONG stockIdx=N stockNo=CODE
 *     name=NAME open=O high=H low=L close=C bid=B ask=A qty=Q decimal=D
 *
 * 時區：log 時間戳為台灣本地時間（UTC+8）
 */

import { existsSync, readFileSync, createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// ── 路徑常數 ──────────────────────────────────────────────────────────
const CAPITAL_HFT_DIR = "D:\\群益及元大API\\CapitalHftService";
const OS_LATEST = path.join(CAPITAL_HFT_DIR, "state", "os_latest_quote_event.json");
const OS_SYM_CACHE = path.join(CAPITAL_HFT_DIR, "state", "os_symbol_cache.json");
const HFT_LOG_DIR = path.join(CAPITAL_HFT_DIR, "logs");
// 優先從根目錄讀取即時狀態（CapitalHftService 主程式寫入），state/ 子目錄可能過��
const HFT_STATUS_ROOT = path.join(CAPITAL_HFT_DIR, "hft_service_status.json");
const HFT_STATUS_STATE = path.join(CAPITAL_HFT_DIR, "state", "hft_service_status.json");
const HFT_STATUS = existsSync(HFT_STATUS_ROOT) ? HFT_STATUS_ROOT : HFT_STATUS_STATE;

// ── 台灣時區偏移（毫秒）──────────────────────────────────────────────
const TW_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

// ── OS Symbol Map：Capital 代碼 → 業界 instrument 名稱 ────────────────
/**
 * 僅收錄「XXXX0000」近月連動合約（最常用）。
 * 業界代碼盡量與 IB/CME 慣例一致（ZN、ZB、6E 等）。
 */
export const OS_SYMBOL_MAP = {
  // ─ CME 股指 ─────────────────────────────────────────────────────────
  ES0000: "ES", // E-mini S&P 500
  MES0000: "MES", // Micro E-mini S&P 500
  NQ0000: "NQ", // E-mini Nasdaq-100
  MNQ0000: "MNQ", // Micro E-mini Nasdaq-100
  RTY0000: "RTY", // E-mini Russell 2000
  M2K0000: "M2K", // Micro E-mini Russell 2000
  NK0000: "NK", // Nikkei 225（CME 美元版）
  MNIK0000: "MNIK", // Micro Nikkei（CME）

  // ─ CBOT 股指 ─────────────────────────────────────────────────────────
  YM0000: "YM", // E-mini Dow Jones
  MYM0000: "MYM", // Micro E-mini Dow

  // ─ COMEX 金屬 ─────────────────────────────────────────────────────────
  GC0000: "GC", // Gold (100 oz)
  MGC0000: "MGC", // Micro Gold (10 oz)
  "1OZ0000": "1OZ", // 1oz Gold
  SI0000: "SI", // Silver (5000 oz)
  SIL0000: "SIL", // Micro Silver
  HG0000: "HG", // Copper
  MHG0000: "MHG", // Micro Copper
  PL0000: "PL", // Platinum
  PLT0000: "PLT", // Platinum TAS
  PA0000: "PA", // Palladium

  // ─ NYMEX 能源 ─────────────────────────────────────────────────────────
  CL0000: "CL", // WTI Crude Oil
  QM0000: "QM", // E-mini WTI Crude
  MCL0000: "MCL", // Micro WTI Crude
  BZ0000: "BZ", // Brent Crude (ICE)
  NG0000: "NG", // Henry Hub Natural Gas
  MNG0000: "MNG", // Micro Natural Gas
  QG0000: "QG", // E-mini Natural Gas
  RB0000: "RB", // RBOB Gasoline
  HO0000: "HO", // Heating Oil

  // ─ CME FX ─────────────────────────────────────────────────────────────
  EC0000: "6E", // Euro (CME, 標準合約 125K EUR)
  E70000: "E7", // Euro E7 (62.5K EUR)
  M6E0000: "M6E", // Micro Euro
  AD0000: "6A", // Australian Dollar (100K AUD)
  M6A0000: "M6A", // Micro AUD
  BP0000: "6B", // British Pound (62.5K GBP)
  M6B0000: "M6B", // Micro GBP
  CD0000: "6C", // Canadian Dollar (100K CAD)
  MCD0000: "MCD", // Micro CAD
  SF0000: "6S", // Swiss Franc (125K CHF)
  JY0000: "6J", // Japanese Yen (12.5M JPY)
  J70000: "J7", // Yen E7
  MP0000: "6M", // Mexican Peso (500K MXN)
  DX0000: "DX", // US Dollar Index (ICE)
  DXS0000: "DXS", // US Dollar Index mini

  // ─ CBOT 利率 ─────────────────────────────────────────────────────────
  US0000: "ZB", // 30yr T-Bond
  TY0000: "ZN", // 10yr T-Note
  TN0000: "TN", // Ultra 10yr T-Note
  UB0000: "UB", // Ultra T-Bond
  FV0000: "ZF", // 5yr T-Note
  TU0000: "ZT", // 2yr T-Note

  // ─ CME SOFR ─────────────────────────────────────────────────────────
  SR30000: "SR3", // 3-Month SOFR
  SR10000: "SR1", // 1-Month SOFR
  FF0000: "FF", // 30-Day Fed Funds

  // ─ CBOE 波動率 ────────────────────────────────────────────────────────
  VX0000: "VX", // VIX Futures
  VXM0000: "VXM", // Micro VIX

  // ─ CBOT 農業 ─────────────────────────────────────────────────────────
  C0000: "ZC", // Corn
  W0000: "ZW", // Wheat (CBOT)
  S0000: "ZS", // Soybean
  BO0000: "ZL", // Soybean Oil
  SM0000: "ZM", // Soybean Meal
  O0000: "ZO", // Oats

  // ─ ICE 軟商品 ─────────────────────────────────────────────────────────
  SB0000: "SB", // Sugar #11
  CT0000: "CT", // Cotton #2
  KC0000: "KC", // Coffee Arabica C
  CC0000: "CC", // Cocoa
  OJF0000: "OJ", // FCOJ (Orange Juice)

  // ─ CME 畜牧 ──────────────────────────────────────────────────────────
  LC0000: "LE", // Live Cattle
  FC0000: "GF", // Feeder Cattle
  LH0000: "HE", // Lean Hogs

  // ─ Eurex 股指 ─────────────────────────────────────────────────────────
  DAX0000: "DAX", // DAX (Eurex)
  ESX0000: "FESX", // Euro Stoxx 50
  ESB0000: "FESB", // Euro Stoxx Banks

  // ─ Eurex 利率 ─────────────────────────────────────────────────────────
  FGBL0000: "FGBL", // Euro Bund (10yr)
  FGBM0000: "FGBM", // Euro Bobl (5yr)
  FGBS0000: "FGBS", // Euro Schatz (2yr)
  FGBX0000: "FGBX", // Euro Buxl (30yr)
  FOAT0000: "FOAT", // French OAT (10yr)
  FBTP0000: "FBTP", // Italian BTP (10yr)

  // ─ Hong Kong (HKFE) ──────────────────────────────────────────────────
  HSI0000: "HSI", // Hang Seng Index
  MHI0000: "MHI", // Mini Hang Seng
  HHI0000: "HHI", // Hang Seng China Enterprises
  MCH0000: "MCH", // Mini HSCE

  // ─ SGX ───────────────────────────────────────────────────────────────
  TWN0000: "TWN", // MSCI Taiwan
  MTWN0000: "MTWN", // Mini MSCI Taiwan
  CN0000: "CN", // FTSE China A50
  SSI0000: "SSI", // SIMSCI (Singapore)
  SG0000: "SG", // SGX Nifty

  // ─ OSE (Japan Exchange) ──────────────────────────────────────────────
  JGB0000: "JGB", // JGB (10yr)
  JAM0000: "JAM", // JPX Nikkei 400
  JAU0000: "JAU", // TOPIX

  // ─ KRX (Korea) ───────────────────────────────────────────────────────
  KS0000: "KOSPI", // KOSPI 200
  MKS0000: "MKOSPI", // Mini KOSPI 200

  // ─ S&P Sector (CME E-mini Select Sector) ─────────────────────────────
  XAE0000: "XAE", // Energy Select Sector
  XAF0000: "XAF", // Financial Select Sector
  XAI0000: "XAI", // Industrial Select Sector
  XAP0000: "XAP", // Consumer Staples Select Sector
  XAU0000: "XAU", // Utilities Select Sector
  XAV0000: "XAV", // Health Care Select Sector

  // ─ CME Rate futures extra ─────────────────────────────────────────────
  RY0000: "RY", // Euro/British Pound cross (CME)

  // ─ FX cross rate additions ────────────────────────────────────────────
  RP0000: "RP", // Euro/British Pound IM
};

/** 反查：instrument → Capital 代碼陣列 */
export const INSTRUMENT_TO_OS = {};
for (const [cap, inst] of Object.entries(OS_SYMBOL_MAP)) {
  if (!INSTRUMENT_TO_OS[inst]) {
    INSTRUMENT_TO_OS[inst] = [];
  }
  INSTRUMENT_TO_OS[inst].push(cap);
}

// ── Log 解析正則 ──────────────────────────────────────────────────────
// 格式：[2026-05-14 00:14:19.338] [os-event] QuoteLONG stockIdx=649 stockNo=MES2606 name=小那熱2606 open=... close=C bid=B ask=A qty=Q decimal=D
const LOG_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[os-event\] QuoteLONG\s+stockIdx=\d+\s+stockNo=(\S+)\s+name=\S+\s+open=(\d+)\s+high=(\d+)\s+low=(\d+)\s+close=(\d+)\s+bid=(\d+)\s+ask=(\d+)\s+qty=(\d+)\s+decimal=(\d+)/;

// ── 工具函數 ───────────────────────────────────────────────────────────
/**
 * 台灣本地時間字串 "2026-05-14 00:14:19.338" → Unix ms（UTC）
 * log 時間戳沒有時區，假定 UTC+8
 */
function twLocalToMs(s) {
  // 把空格換成 T、補 +08:00 → ISO 8601
  return new Date(s.replace(" ", "T") + "+08:00").getTime();
}

// ── 1. 即時快照 ────────────────────────────────────────────────────────

/**
 * 讀取多符號快取（os-quote-cache.mjs 維護的 os_symbol_cache.json）
 * @param {string} symbol  Capital 代碼或 instrument 名
 * @returns {{ symbol, instrument, name, price, bid, ask, qty, time } | null}
 */
export function fetchOsCached(symbol) {
  if (!symbol || !existsSync(OS_SYM_CACHE)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(OS_SYM_CACHE, "utf-8"));
    const syms = data.symbols ?? {};
    const upper = symbol.toUpperCase();

    // 直接用 Capital 代碼查
    if (syms[upper]) {
      const e = syms[upper];
      return {
        symbol: e.symbol,
        instrument: e.instrument,
        name: e.name ?? "",
        price: e.price,
        bid: e.bid,
        ask: e.ask,
        qty: e.qty ?? 0,
        time: e.time,
      };
    }
    // 用 instrument 名反查（如 'ES' → 'ES0000'）
    for (const rec of Object.values(syms)) {
      if (rec.instrument?.toUpperCase() === upper) {
        return {
          symbol: rec.symbol,
          instrument: rec.instrument,
          name: rec.name ?? "",
          price: rec.price,
          bid: rec.bid,
          ask: rec.ask,
          qty: rec.qty ?? 0,
          time: rec.time,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 讀取 os_latest_quote_event.json 即時報價（最新單一商品）
 * 若有指定 symbol 且當前快照不符，改由多符號快取補充。
 *
 * @param {string} [symbol]  Capital OS 代碼（'ES0000'）或 instrument 名（'ES'）；
 *                           若省略則直接回傳目前最新的任意商品
 * @returns {{ symbol, instrument, name, price, bid, ask, qty, time } | null}
 */
export function fetchOsLatest(symbol = null) {
  // 先從最新單一事件讀取
  let ev = null;
  if (existsSync(OS_LATEST)) {
    try {
      ev = JSON.parse(readFileSync(OS_LATEST, "utf-8"));
    } catch {
      ev = null;
    }
  }

  if (ev) {
    const upperSym = symbol?.toUpperCase();
    const matchesCap = !symbol || ev.stockNo?.toUpperCase() === upperSym;
    const matchesInst = !symbol || OS_SYMBOL_MAP[ev.stockNo]?.toUpperCase() === upperSym;

    if (matchesCap || matchesInst) {
      const dec = Number.parseInt(ev.decimal ?? 2, 10);
      const factor = 10 ** dec;
      const rawC = Number.parseInt(ev.close ?? 0, 10);
      const rawB = Number.parseInt(ev.bid ?? 0, 10);
      const rawA = Number.parseInt(ev.ask ?? 0, 10);
      const price = (rawC > 0 ? rawC : rawB) / factor;
      if (price > 0) {
        return {
          symbol: ev.stockNo,
          instrument: OS_SYMBOL_MAP[ev.stockNo] ?? ev.stockNo,
          name: ev.stockName,
          price,
          bid: rawB > 0 ? rawB / factor : price,
          ask: rawA > 0 ? rawA / factor : price,
          qty: Number.parseInt(ev.qty ?? 0, 10),
          time: ev.receivedAt,
        };
      }
    }
  }

  // 若指定了 symbol 但最新事件不符，從多符號快取補充
  if (symbol) {
    return fetchOsCached(symbol);
  }
  return null;
}

// ── 2. 從 HFT Log 讀取歷史 tick ─────────────────────────────────────────
/**
 * 根據 since/until 日期決定應掃描哪些 log 檔案
 * @param {number} sinceTs  Unix ms（0 = 無限制）
 * @param {number} untilTs  Unix ms（Infinity = 無限制）
 * @returns {Promise<string[]>} 排序後的 log 絕對路徑陣列
 */
async function _resolveLogFiles(sinceTs, untilTs) {
  if (!existsSync(HFT_LOG_DIR)) {
    return [];
  }
  const files = (await readdir(HFT_LOG_DIR)).filter((f) => /^\d{8}\.log$/.test(f)).toSorted();

  return files
    .map((f) => {
      // 以 YYYYMMDD 當天 00:00 ~ 23:59 (TWN = UTC+8) 做粗濾
      const d = f.slice(0, 8); // '20260514'
      const y = Number.parseInt(d.slice(0, 4), 10),
        m = Number.parseInt(d.slice(4, 6), 10) - 1,
        day = Number.parseInt(d.slice(6, 8), 10);
      const dayStartMs = Date.UTC(y, m, day) - TW_OFFSET_MS; // 前一天 16:00 UTC = 當日 00:00 TWN
      const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000 - 1;
      if (dayEndMs < sinceTs || dayStartMs > untilTs) {
        return null;
      }
      return path.join(HFT_LOG_DIR, f);
    })
    .filter(Boolean);
}

/**
 * 從 hft-service log 讀取 OS tick
 * @param {string|string[]} symbols  Capital 代碼（'ES0000'）或 instrument 名（'ES'）
 *                                   或陣列；傳 null/undefined 讀全部
 * @param {object} opts
 * @param {string} [opts.since]    ISO 時間字串（含，預設全部）
 * @param {string} [opts.until]    ISO 時間字串（含，預設全部）
 * @param {number} [opts.limit]    最多回傳幾筆
 * @param {string} [opts.logDate]  只讀指定日期（'20260514'，覆蓋 since/until 日期範圍）
 * @returns {Promise<Array<{time, ts, price, bid, ask, qty, open, high, low, symbol, instrument}>>}
 */
export async function readOsLogTicks(symbols, { since, until, limit, logDate } = {}) {
  // 建立符號集合（同時支援 Capital 代碼 & instrument 名）
  let symSet = null;
  if (symbols) {
    const arr = Array.isArray(symbols) ? symbols : [symbols];
    symSet = new Set();
    for (const s of arr) {
      const up = s.toUpperCase();
      // 若看起來是 Capital 代碼（含數字）
      if (/\d/.test(up) || up.endsWith("0000")) {
        symSet.add(up);
      } else {
        // instrument 名 → 查反向表
        const caps = INSTRUMENT_TO_OS[up] ?? INSTRUMENT_TO_OS[s] ?? [];
        for (const c of caps) {
          symSet.add(c);
        }
        // 也把原始值加入，以防 map 裡沒有但 log 有
        symSet.add(up);
      }
    }
  }

  const sinceTs = since ? new Date(since).getTime() : 0;
  const untilTs = until ? new Date(until).getTime() : Infinity;

  let logFiles;
  if (logDate) {
    const p = path.join(HFT_LOG_DIR, `${logDate}.log`);
    logFiles = existsSync(p) ? [p] : [];
  } else {
    logFiles = await _resolveLogFiles(sinceTs, untilTs);
  }

  const ticks = [];

  for (const logPath of logFiles) {
    await new Promise((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(logPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        if (limit && ticks.length >= limit) {
          rl.close();
          return;
        }
        if (!line.includes("[os-event]") || !line.includes("QuoteLONG")) {
          return;
        }

        const m = LOG_RE.exec(line);
        if (!m) {
          return;
        }

        const [
          ,
          timeStr,
          stockNo,
          openRaw,
          highRaw,
          lowRaw,
          closeRaw,
          bidRaw,
          askRaw,
          qtyRaw,
          decRaw,
        ] = m;

        if (symSet && !symSet.has(stockNo.toUpperCase())) {
          return;
        }

        const ts = twLocalToMs(timeStr);
        if (ts < sinceTs || ts > untilTs) {
          return;
        }

        const dec = Number.parseInt(decRaw, 10);
        const factor = 10 ** dec;

        const rawC = Number.parseInt(closeRaw, 10);
        const rawB = Number.parseInt(bidRaw, 10);
        const price = (rawC > 0 ? rawC : rawB) / factor;
        if (!price || price <= 0 || !Number.isFinite(price)) {
          return;
        }

        ticks.push({
          time: new Date(ts).toISOString(),
          ts,
          price,
          open: Number.parseInt(openRaw, 10) / factor,
          high: Number.parseInt(highRaw, 10) / factor,
          low: Number.parseInt(lowRaw, 10) / factor,
          bid: rawB > 0 ? rawB / factor : price,
          ask: Number.parseInt(askRaw, 10) > 0 ? Number.parseInt(askRaw, 10) / factor : price,
          qty: Number.parseInt(qtyRaw, 10),
          symbol: stockNo,
          instrument: OS_SYMBOL_MAP[stockNo] ?? stockNo,
        });
      });

      rl.on("close", resolve);
      rl.on("error", reject);
    });
  }

  return ticks;
}

// ── 2b. 多商品單次掃描（快速路徑）────────────────────────────────────
/**
 * 一次掃描 log 檔案，同時收集多個商品的 tick（比並行呼叫 readOsLogTicks 快 N 倍）
 * @param {string[]} symbols     Capital 代碼陣列（'ES0000', 'NQ0000', ...）
 * @param {object}   opts        同 readOsLogTicks opts（但不支援 limit）
 * @returns {Promise<Record<string, Array>>}  { 'ES0000': [...ticks], 'NQ0000': [...ticks], ... }
 */
export async function readOsLogMulti(symbols, { since, until, logDate } = {}) {
  const symArr = Array.isArray(symbols) ? symbols : [symbols];
  const symSet = new Set(symArr.map((s) => s.toUpperCase()));

  // 建立結果桶
  const buckets = {};
  for (const s of symArr) {
    buckets[s.toUpperCase()] = [];
  }

  const sinceTs = since ? new Date(since).getTime() : 0;
  const untilTs = until ? new Date(until).getTime() : Infinity;

  let logFiles;
  if (logDate) {
    const p = path.join(HFT_LOG_DIR, `${logDate}.log`);
    logFiles = existsSync(p) ? [p] : [];
  } else {
    logFiles = await _resolveLogFiles(sinceTs, untilTs);
  }

  for (const logPath of logFiles) {
    await new Promise((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(logPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        if (!line.includes("[os-event]") || !line.includes("QuoteLONG")) {
          return;
        }

        const m = LOG_RE.exec(line);
        if (!m) {
          return;
        }

        const [
          ,
          timeStr,
          stockNo,
          openRaw,
          highRaw,
          lowRaw,
          closeRaw,
          bidRaw,
          askRaw,
          qtyRaw,
          decRaw,
        ] = m;
        const upCode = stockNo.toUpperCase();
        if (!symSet.has(upCode)) {
          return;
        }

        const ts = twLocalToMs(timeStr);
        if (ts < sinceTs || ts > untilTs) {
          return;
        }

        const dec = Number.parseInt(decRaw, 10);
        const factor = 10 ** dec;
        const rawC = Number.parseInt(closeRaw, 10);
        const rawB = Number.parseInt(bidRaw, 10);
        const price = (rawC > 0 ? rawC : rawB) / factor;
        if (!price || price <= 0 || !Number.isFinite(price)) {
          return;
        }

        buckets[upCode].push({
          time: new Date(ts).toISOString(),
          ts,
          price,
          open: Number.parseInt(openRaw, 10) / factor,
          high: Number.parseInt(highRaw, 10) / factor,
          low: Number.parseInt(lowRaw, 10) / factor,
          bid: rawB > 0 ? rawB / factor : price,
          ask: Number.parseInt(askRaw, 10) > 0 ? Number.parseInt(askRaw, 10) / factor : price,
          qty: Number.parseInt(qtyRaw, 10),
          symbol: stockNo,
          instrument: OS_SYMBOL_MAP[stockNo] ?? stockNo,
        });
      });

      rl.on("close", resolve);
      rl.on("error", reject);
    });
  }

  return buckets;
}

// ── 3. 聚合 tick → OHLCV K 棒 ────────────────────────────────────────
/**
 * 將 tick 陣列聚合為 OHLCV bar（與 CapitalFeed.buildBars 相同邏輯）
 * @param {Array}  ticks       readOsLogTicks() 的輸出
 * @param {number} intervalMs  K 棒週期（毫秒）：60000=1分, 300000=5分, 3600000=1小時
 * @returns {Array<{time, open, high, low, close, volume, ticks, symbol, instrument}>}
 */
export function buildOsLogBars(ticks, intervalMs = 60_000) {
  if (!ticks.length) {
    return [];
  }

  const sorted = [...ticks].toSorted((a, b) => a.ts - b.ts);
  const bars = [];
  let bar = null;
  let barEnd = 0;

  for (const t of sorted) {
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
        symbol: t.symbol,
        instrument: t.instrument,
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

// ── 4. 一步取得 K 棒 ─────────────────────────────────────────────────
/**
 * 讀取 OS log 並聚合為 OHLCV K 棒
 * @param {string|string[]} symbols     Capital 代碼或 instrument 名
 * @param {object}          opts
 * @param {number} [opts.intervalMs]    K 棒週期毫秒（預設 60000=1分鐘）
 * @param {string} [opts.interval]      '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'1d'
 * @param {string} [opts.since]         只取此時間後
 * @param {string} [opts.until]         只取此時間前
 * @param {string} [opts.logDate]       只讀指定日期（'20260514'）
 * @returns {Promise<Array<OhlcvBar>>}
 */
export async function fetchOsLogBars(symbols, opts = {}) {
  const intervalMs = opts.intervalMs ?? _parseInterval(opts.interval ?? "1m");
  const ticks = await readOsLogTicks(symbols, opts);
  return buildOsLogBars(ticks, intervalMs);
}

// ── 5. HFT 服務狀態 ───────────────────────────────────────────────────
/**
 * 讀取 hft_service_status.json
 * @returns {{ status, loginStatus, osQuotesReceived, subscribedOsStocks } | null}
 */
export function getHftStatus() {
  if (!existsSync(HFT_STATUS)) {
    return null;
  }
  try {
    const d = JSON.parse(readFileSync(HFT_STATUS, "utf-8"));
    return {
      status: d.status,
      loginStatus: d.loginStatus,
      osQuotesReceived: d.osQuoteStats?.quoteCount ?? d.osQuotesReceived ?? d.totalOsQuotesReceived,
      osLastQuoteAt: d.osQuoteStats?.lastQuoteAt,
      subscribedOsStocks: d.subscribedOsStocks ?? [],
      updatedAt: d.updatedAt ?? d.generatedAt,
    };
  } catch {
    return null;
  }
}

// ── 6. 列出可用 OS 日誌日期 ──────────────────────────────────────────
/**
 * 列出 HFT log 目錄中已有的日誌日期
 * @returns {Promise<string[]>}  如 ['20260513', '20260514']
 */
export async function listOsLogDates() {
  if (!existsSync(HFT_LOG_DIR)) {
    return [];
  }
  const files = await readdir(HFT_LOG_DIR);
  return files
    .filter((f) => /^\d{8}\.log$/.test(f))
    .map((f) => f.slice(0, 8))
    .toSorted();
}

// ── 私有：解析 interval 字串 ──────────────────────────────────────────
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
