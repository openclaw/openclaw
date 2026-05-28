/**
 * openclaw-capital-strategy-engine.mjs
 *
 * 台指期貨（TX）策略引擎 — 從 tick 流建立 K 棒，執行多策略信號產生。
 *
 * 實作策略：
 *   1. ORB  — Opening Range Breakout（開盤區間突破）
 *   2. EMA  — EMA 5/20 趨勢跟蹤（雙均線金叉死叉）
 *   3. VWAP — VWAP 均值回歸（價格偏離 VWAP ±1.5σ）
 *
 * 安全約束：
 *   - 不登入 broker，不下真實委託
 *   - allowLiveTrading: false，writeBrokerOrders: false
 *   - 所有輸出均為 paper intent（模擬信號）
 *
 * Schema: openclaw.capital.strategy-signal.v1
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { resolveCapitalStrategySymbol } from "./lib/capital-strategy-symbol-resolver.mjs";

const SCHEMA = "openclaw.capital.strategy-signal.v1";

// ─── 常數 ──────────────────────────────────────────────────────────────
// 台指小台（MX）每點 50 TWD；台指大台（TX）每點 200 TWD
const INSTRUMENT_CONFIG = {
  TX06: { pointValue: 200, tickSize: 1, symbol: "TX06", name: "台指06月", currency: "TWD" },
  TX00: { pointValue: 200, tickSize: 1, symbol: "TX00", name: "台指當月", currency: "TWD" },
  TE00AM: {
    pointValue: 50,
    tickSize: 0.01,
    symbol: "TE00AM",
    name: "電子期當月(AM)",
    currency: "TWD",
  },
};

// 日盤交易時段（台灣時間）
const DAY_SESSION_START_TWT = "08:45";
const DAY_SESSION_END_TWT = "13:45";

// ─── 工具函式 ───────────────────────────────────────────────────────────

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonlLinesOptional(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function digestJsonlLines(lines) {
  return lines.length > 0 ? sha256Text(`${lines.join("\n")}\n`) : "";
}

function intentLifecyclePaths(intentsPath) {
  const parsed = path.parse(intentsPath);
  return {
    rejectedLatestPath: path.join(parsed.dir, `${parsed.name}-rejected-latest.json`),
    epochsPath: path.join(parsed.dir, `${parsed.name}-epochs.jsonl`),
  };
}

async function writeIntentLifecycleEpoch({
  intentsPath,
  intentRunId,
  status,
  reason,
  generatedAt,
}) {
  const previousLines = await readJsonlLinesOptional(intentsPath);
  const paths = intentLifecyclePaths(intentsPath);
  const report = {
    schema: "openclaw.capital.paper-intent-epoch.v1",
    generatedAt,
    status,
    reason,
    activeIntentsPath: intentsPath,
    intentRunId,
    previousRecordCount: previousLines.length,
    previousDigest: digestJsonlLines(previousLines),
    lifecycleFiles: paths,
    safetyLock: safetyLock(),
  };
  await writeJsonWithSha(paths.rejectedLatestPath, report);
  await appendJsonLine(paths.epochsPath, report);
  return report;
}

async function clearIntentsWithLifecycle({
  intentsPath,
  intentRunId,
  status,
  reason,
  generatedAt,
}) {
  const lifecycle = await writeIntentLifecycleEpoch({
    intentsPath,
    intentRunId,
    status,
    reason,
    generatedAt,
  });
  await fs.mkdir(path.dirname(intentsPath), { recursive: true });
  await fs.writeFile(intentsPath, "", "utf8");
  return lifecycle;
}

/** 台灣時間（TWT = UTC+8）轉換 */
function toTWT(dateObj) {
  const offset = 8 * 60 * 60 * 1000;
  return new Date(dateObj.getTime() + offset);
}

function twtDateStr(dateObj) {
  const d = toTWT(dateObj);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function inDaySession(hhmm) {
  return hhmm >= DAY_SESSION_START_TWT && hhmm <= DAY_SESSION_END_TWT;
}

function rawSummaryField(event, fieldName) {
  const rawSummary = String(event.rawSummary ?? "");
  const match = rawSummary.match(new RegExp(`${fieldName}=(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number.parseFloat(match[1]) : NaN;
}

function normalizeQuoteNumber(event, fieldName) {
  const value = Number.parseFloat(String(event[fieldName] ?? ""));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const decimal = Number(event.decimal ?? 0);
  const factor = decimal > 0 ? 10 ** decimal : 1;
  const rawValue = rawSummaryField(event, fieldName);
  if (!Number.isFinite(rawValue) || factor <= 1) {
    return value;
  }

  const normalizedRaw = rawValue / factor;
  if (Math.abs(value - normalizedRaw) < 0.000001) {
    return value;
  }
  if (Math.abs(value - rawValue) < 0.000001) {
    return normalizedRaw;
  }
  return value >= 1_000_000 ? value / factor : value;
}

function fallbackSnapshotSymbolForQuery(query) {
  const normalized = String(query ?? "tx-front")
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, "");
  if (
    ["TX-FRONT", "TX_FRONT", "TXFRONT", "TXF", "TXFR1", "TX00", "台指近", "台指期近"].includes(
      normalized,
    )
  ) {
    return "TX00";
  }
  return "";
}

function activeStrategySymbolForQuoteSymbol(symbol) {
  const normalized = String(symbol ?? "")
    .trim()
    .toUpperCase();
  const legacyAlias = normalized.match(/^(?<base>TX(?:00|06))(?:AM|PM)$/u);
  return legacyAlias?.groups?.base ?? normalized;
}

function canUseHistoricalResolvedSymbol(resolvedSymbol) {
  return (
    Boolean(resolvedSymbol?.resolvedSymbol) &&
    !["invalid_legacy_session_alias", "missing_product_mapping"].includes(
      String(resolvedSymbol.status ?? ""),
    )
  );
}

function baseSafetyFields() {
  return {
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
  };
}

function safetyLock() {
  return {
    allowLiveTrading: false,
    writeBrokerOrders: false,
    promoteLiveAutomatically: false,
  };
}

// ─── 技術指標 ────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) {
    return null;
  }
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(bars, period = 14) {
  if (bars.length < 2) {
    return null;
  }
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length < period) {
    return trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length;
  }
  return trueRanges.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function calcVWAP(bars) {
  let cumulTV = 0,
    cumulVol = 0;
  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulTV += typicalPrice * (bar.volume || 1);
    cumulVol += bar.volume || 1;
  }
  return cumulVol > 0 ? cumulTV / cumulVol : null;
}

function calcVWAPStdDev(bars, vwap) {
  if (!vwap) {
    return 0;
  }
  let cumulVol = 0,
    cumulVar = 0;
  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume || 1;
    cumulVar += (tp - vwap) ** 2 * v;
    cumulVol += v;
  }
  return cumulVol > 0 ? Math.sqrt(cumulVar / cumulVol) : 0;
}

// ─── K 棒建立器 ──────────────────────────────────────────────────────────

export class BarBuilder {
  constructor({ symbol, timeframeMinutes = 1 }) {
    this.symbol = symbol;
    this.tfMin = timeframeMinutes;
    this.bars = [];
    this.currentBar = null;
    this.currentBarKey = "";
  }

  /**
   * 輸入 tick 事件（來自 capital_quote_events.jsonl），更新 K 棒
   * @param {object} event - quote event JSON
   * @returns {object|null} 如果有收盤的 bar 則回傳，否則 null
   */
  addTick(event) {
    const close = normalizeQuoteNumber(event, "close");
    const bid = normalizeQuoteNumber(event, "bid");
    const ask = normalizeQuoteNumber(event, "ask");
    const qty = Number.parseInt(String(event.qty ?? ""), 10) || 0;
    const ts = new Date(event.receivedAt);

    if (!close || close <= 0) {
      return null;
    }

    const twtMins = (ts.getUTCHours() * 60 + ts.getUTCMinutes() + 8 * 60) % (24 * 60);
    const twtH = Math.floor(twtMins / 60);
    const twtM = Math.floor(twtMins / this.tfMin) * this.tfMin;
    const barKey = `${twtDateStr(ts)}_${String(twtH).padStart(2, "0")}:${String(twtM % 60).padStart(2, "0")}`;
    const hhmm = `${String(twtH).padStart(2, "0")}:${String(twtMins % 60).padStart(2, "0")}`;

    let completedBar = null;

    if (barKey !== this.currentBarKey) {
      if (this.currentBar) {
        completedBar = { ...this.currentBar };
        this.bars.push(completedBar);
        // 只保留最近 200 棒
        if (this.bars.length > 200) {
          this.bars.shift();
        }
      }
      this.currentBarKey = barKey;
      this.currentBar = {
        symbol: this.symbol,
        date: twtDateStr(ts),
        hhmm,
        barKey,
        inDaySession: inDaySession(hhmm),
        open: close,
        high: close,
        low: close,
        close,
        bid,
        ask,
        volume: qty,
        ticks: 1,
        tsOpen: ts.toISOString(),
        tsClose: ts.toISOString(),
      };
    } else {
      const b = this.currentBar;
      b.high = Math.max(b.high, close);
      b.low = Math.min(b.low, close);
      b.close = close;
      b.bid = bid;
      b.ask = ask;
      b.volume += qty;
      b.ticks += 1;
      b.tsClose = ts.toISOString();
    }

    return completedBar;
  }

  /** 取得包含當前未完成棒的所有 K 棒 */
  getAllBars() {
    const result = [...this.bars];
    if (this.currentBar) {
      result.push({ ...this.currentBar });
    }
    return result;
  }

  /** 只取日盤 K 棒 */
  getDaySessionBars() {
    return this.getAllBars().filter((b) => b.inDaySession);
  }
}

// ─── 策略 1：Opening Range Breakout (ORB) ───────────────────────────────

export class OrbStrategy {
  constructor({ orbMinutes = 30, riskRewardRatio = 1.5, stopPct = 0.5 } = {}) {
    this.orbMinutes = orbMinutes; // 開盤區間時間（分鐘）
    this.rrRatio = riskRewardRatio;
    this.stopPct = stopPct; // stop = stopPct × range

    this.state = "waiting"; // waiting | range_set | triggered | done
    this.sessionDate = "";
    this.orHigh = 0;
    this.orLow = 0;
    this.signal = null;
  }

  reset() {
    this.state = "waiting";
    this.sessionDate = "";
    this.orHigh = 0;
    this.orLow = 0;
    this.signal = null;
  }

  /**
   * 接收已完成的 K 棒，回傳信號或 null
   * @returns {object|null} signal
   */
  onBar(bar) {
    if (!bar.inDaySession) {
      return null;
    }

    // 新交易日重置
    if (bar.date !== this.sessionDate) {
      this.reset();
      this.sessionDate = bar.date;
      this.state = "building_range";
    }

    // 計算開盤區間結束時間
    const [startH, startM] = DAY_SESSION_START_TWT.split(":").map(Number);
    const orbEndMins = startH * 60 + startM + this.orbMinutes;
    const orbEndH = Math.floor(orbEndMins / 60);
    const orbEndMin = orbEndMins % 60;
    const orbEndHHMM = `${String(orbEndH).padStart(2, "0")}:${String(orbEndMin).padStart(2, "0")}`;

    if (this.state === "building_range") {
      // 建立開盤區間
      if (!this.orHigh) {
        this.orHigh = bar.high;
        this.orLow = bar.low;
      } else {
        this.orHigh = Math.max(this.orHigh, bar.high);
        this.orLow = Math.min(this.orLow, bar.low);
      }

      // 區間建立完成
      if (bar.hhmm >= orbEndHHMM) {
        this.state = "range_set";
      }
      return null;
    }

    if (this.state === "range_set" || this.state === "triggered") {
      if (this.state === "triggered") {
        return null; // 當日已觸發，不再產生信號
      }

      const range = this.orHigh - this.orLow;
      if (range <= 0) {
        return null;
      }

      const stopDist = range * this.stopPct;
      const targetDist = range * this.rrRatio;

      // 長突破
      if (bar.close > this.orHigh) {
        this.state = "triggered";
        this.signal = {
          type: "orb_long",
          direction: "long",
          entryPrice: this.orHigh + 1,
          stopPrice: this.orHigh - stopDist,
          targetPrice: this.orHigh + targetDist,
          orHigh: this.orHigh,
          orLow: this.orLow,
          orRange: range,
          triggerBar: bar.barKey,
          confidence: 0.6,
          reason: `ORB 多頭突破：close ${bar.close} > orHigh ${this.orHigh}，區間 ${range.toFixed(0)}pts`,
        };
        return { ...this.signal, barSnapshot: bar };
      }

      // 空突破
      if (bar.close < this.orLow) {
        this.state = "triggered";
        this.signal = {
          type: "orb_short",
          direction: "short",
          entryPrice: this.orLow - 1,
          stopPrice: this.orLow + stopDist,
          targetPrice: this.orLow - targetDist,
          orHigh: this.orHigh,
          orLow: this.orLow,
          orRange: range,
          triggerBar: bar.barKey,
          confidence: 0.6,
          reason: `ORB 空頭突破：close ${bar.close} < orLow ${this.orLow}，區間 ${range.toFixed(0)}pts`,
        };
        return { ...this.signal, barSnapshot: bar };
      }
    }

    return null;
  }
}

// ─── 策略 2：EMA 趨勢跟蹤 ────────────────────────────────────────────────

export class EmaTrendStrategy {
  constructor({
    fastPeriod = 5,
    slowPeriod = 20,
    minAtrMult = 1.0,
    cooldownBars = 15,
    minAtrThreshold = 50,
  } = {}) {
    this.fast = fastPeriod;
    this.slow = slowPeriod;
    this.minAtrMult = minAtrMult;
    this.cooldownBars = cooldownBars; // 兩個信號之間最少間隔棒數（防過度交易）
    this.minAtrThreshold = minAtrThreshold; // ATR 最小閾值（低波動不交易）
    this.prevCross = null; // "above" | "below"
    this.lastSignalBar = -999;
    this.barCount = 0;
  }

  onBars(bars) {
    this.barCount = bars.length;
    if (bars.length < this.slow + 2) {
      return null;
    }
    const closes = bars.map((b) => b.close);

    const emaFast = calcEMA(closes, this.fast);
    const emaSlow = calcEMA(closes, this.slow);
    if (!emaFast || !emaSlow) {
      return null;
    }

    const prevCloses = closes.slice(0, -1);
    const prevEmaFast = calcEMA(prevCloses, this.fast);
    const prevEmaSlow = calcEMA(prevCloses, this.slow);
    if (!prevEmaFast || !prevEmaSlow) {
      return null;
    }

    const atr = calcATR(bars.slice(-15));
    if (!atr) {
      return null;
    }

    // 低波動市場不交易
    if (atr < this.minAtrThreshold) {
      return null;
    }

    // 冷卻期：防止頻繁進出
    if (bars.length - this.lastSignalBar < this.cooldownBars) {
      return null;
    }

    const crossAbove = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
    const crossBelow = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;

    const lastBar = bars[bars.length - 1];
    if (!lastBar.inDaySession) {
      return null;
    }

    // 額外過濾：確認穿越程度夠大（避免假突破）
    const crossMagnitude = Math.abs(emaFast - emaSlow);
    if (crossMagnitude < atr * 0.1) {
      return null;
    }

    if (crossAbove && this.prevCross !== "above") {
      this.prevCross = "above";
      this.lastSignalBar = bars.length;
      const stopDist = atr * this.minAtrMult;
      return {
        type: "ema_long",
        direction: "long",
        entryPrice: lastBar.close,
        stopPrice: lastBar.close - stopDist * 2,
        targetPrice: lastBar.close + stopDist * 3,
        emaFast: Math.round(emaFast * 10) / 10,
        emaSlow: Math.round(emaSlow * 10) / 10,
        atr: Math.round(atr * 10) / 10,
        confidence: 0.55,
        reason: `EMA 金叉（ATR=${atr.toFixed(0)}，冷卻 ${this.cooldownBars}棒）：EMA${this.fast}(${emaFast.toFixed(0)}) 上穿 EMA${this.slow}(${emaSlow.toFixed(0)})`,
        barSnapshot: lastBar,
      };
    }

    if (crossBelow && this.prevCross !== "below") {
      this.prevCross = "below";
      this.lastSignalBar = bars.length;
      const stopDist = atr * this.minAtrMult;
      return {
        type: "ema_short",
        direction: "short",
        entryPrice: lastBar.close,
        stopPrice: lastBar.close + stopDist * 2,
        targetPrice: lastBar.close - stopDist * 3,
        emaFast: Math.round(emaFast * 10) / 10,
        emaSlow: Math.round(emaSlow * 10) / 10,
        atr: Math.round(atr * 10) / 10,
        confidence: 0.55,
        reason: `EMA 死叉（ATR=${atr.toFixed(0)}，冷卻 ${this.cooldownBars}棒）：EMA${this.fast}(${emaFast.toFixed(0)}) 下穿 EMA${this.slow}(${emaSlow.toFixed(0)})`,
        barSnapshot: lastBar,
      };
    }

    return null;
  }
}

// ─── 策略 3：VWAP 均值回歸 ───────────────────────────────────────────────

export class VwapMeanRevertStrategy {
  constructor({ deviationMult = 1.5, minBars = 10 } = {}) {
    this.devMult = deviationMult;
    this.minBars = minBars;
    this.lastSignalType = null;
  }

  onBars(bars) {
    const dayBars = bars.filter((b) => b.inDaySession);
    if (dayBars.length < this.minBars) {
      return null;
    }

    const vwap = calcVWAP(dayBars);
    const stdDev = calcVWAPStdDev(dayBars, vwap);
    if (!vwap || stdDev < 1) {
      return null;
    }

    const lastBar = dayBars[dayBars.length - 1];
    const close = lastBar.close;
    const upper = vwap + this.devMult * stdDev;
    const lower = vwap - this.devMult * stdDev;

    const atr = calcATR(dayBars.slice(-14)) ?? stdDev;

    // 超賣反彈：close 跌破 lower → 買入
    if (close < lower && this.lastSignalType !== "vwap_long") {
      this.lastSignalType = "vwap_long";
      return {
        type: "vwap_long",
        direction: "long",
        entryPrice: close,
        stopPrice: close - atr * 1.5,
        targetPrice: vwap, // 目標回到 VWAP
        vwap: Math.round(vwap * 10) / 10,
        upper: Math.round(upper * 10) / 10,
        lower: Math.round(lower * 10) / 10,
        stdDev: Math.round(stdDev * 10) / 10,
        confidence: 0.5,
        reason: `VWAP 超賣：close ${close} < lower ${lower.toFixed(0)} (VWAP ${vwap.toFixed(0)} - ${this.devMult}σ)`,
        barSnapshot: lastBar,
      };
    }

    // 超買回落：close 突破 upper → 做空
    if (close > upper && this.lastSignalType !== "vwap_short") {
      this.lastSignalType = "vwap_short";
      return {
        type: "vwap_short",
        direction: "short",
        entryPrice: close,
        stopPrice: close + atr * 1.5,
        targetPrice: vwap,
        vwap: Math.round(vwap * 10) / 10,
        upper: Math.round(upper * 10) / 10,
        lower: Math.round(lower * 10) / 10,
        stdDev: Math.round(stdDev * 10) / 10,
        confidence: 0.5,
        reason: `VWAP 超買：close ${close} > upper ${upper.toFixed(0)} (VWAP ${vwap.toFixed(0)} + ${this.devMult}σ)`,
        barSnapshot: lastBar,
      };
    }

    return null;
  }
}

// ─── 信號 → Paper Intent 轉換 ────────────────────────────────────────────

function signalToIntent(signal, symbol, now, instrumentCfg, context = {}) {
  const pv = instrumentCfg?.pointValue ?? 200;
  const stop = signal.stopPrice ?? 0;
  const target = signal.targetPrice ?? 0;
  const entry = signal.entryPrice ?? 0;
  const riskPts = Math.abs(entry - stop);
  const riskTWD = riskPts * pv;
  const rewardPts = Math.abs(entry - target);
  const rewardTWD = rewardPts * pv;

  return {
    schema: "openclaw.capital.paper-intent.v2",
    intentId: crypto.randomUUID(),
    intentRunId: context.intentRunId ?? "",
    generatedAt: now.toISOString(),
    symbol,
    strategy: signal.type ?? "unknown",
    direction: signal.direction ?? "long",
    price: Math.round(entry),
    stopLoss: Math.round(stop),
    takeProfit: Math.round(target),
    riskPts: Math.round(riskPts * 10) / 10,
    rewardPts: Math.round(rewardPts * 10) / 10,
    riskTWD: Math.round(riskTWD),
    rewardTWD: Math.round(rewardTWD),
    riskRewardRatio: riskPts > 0 ? Math.round((rewardPts / riskPts) * 100) / 100 : 0,
    confidence: signal.confidence ?? 0,
    reason: signal.reason ?? "",
    paperOnly: true,
    executionEligible: context.resolverReady === true,
    resolverReady: context.resolverReady === true,
    historicalSnapshot: context.historicalFallbackUsed === true,
    promotionBlocked: context.historicalFallbackUsed === true,
    sourceEvent: {
      bid: signal.barSnapshot?.bid ?? entry,
      ask: signal.barSnapshot?.ask ?? entry,
      close: signal.barSnapshot?.close ?? entry,
      time: signal.barSnapshot?.tsClose ?? now.toISOString(),
    },
    meta: {
      orbHigh: signal.orHigh,
      orbLow: signal.orLow,
      orbRange: signal.orRange,
      emaFast: signal.emaFast,
      emaSlow: signal.emaSlow,
      vwap: signal.vwap,
      atr: signal.atr,
    },
    // 安全鎖定
    allowLiveTrading: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    promoteLiveAuto: false,
  };
}

// ─── 主執行函式 ───────────────────────────────────────────────────────────

/**
 * 讀取 tick 流，執行策略，輸出 paper intent 及信號報告
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.ticksPath]    - capital_quote_events.jsonl 路徑
 * @param {string} [options.intentsPath]  - 輸出 paper intents
 * @param {string} [options.reportPath]   - 輸出信號報告
 * @param {string} [options.symbol]       - 商品代碼/商品別名，預設 tx-front
 * @param {boolean} [options.appendIntents] - 是否追加 intents（預設 false = 覆寫）
 */
export async function runStrategyEngine(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());

  // 路徑設定
  const hftStateDir = process.env.CAPITAL_HFT_STATE_DIR ?? resolveCapitalHftStateDir();
  const resolvedSymbol =
    options.resolveSymbol === false
      ? {
          ok: true,
          requestedSymbol: options.symbol ?? "TX00",
          resolvedSymbol: options.symbol ?? "TX00",
          status: "explicit_symbol",
          reason: "Symbol resolver disabled by caller.",
        }
      : await resolveCapitalStrategySymbol({
          query: options.symbol ?? "tx-front",
          repoRoot,
          stateDir: hftStateDir,
        }).catch((error) => ({
          ok: false,
          requestedSymbol: options.symbol ?? "tx-front",
          resolvedSymbol: fallbackSnapshotSymbolForQuery(options.symbol ?? "tx-front"),
          productId: "tx-front",
          status: "resolver_error",
          reason: `Symbol resolver failed; using historical paper evaluation only. ${error instanceof Error ? error.message : String(error)}`,
          diagnostic: {
            blockerCode: "symbol_resolver_error",
            probableCause:
              "CapitalHftService state file was read while partially written or invalid.",
            unblockCondition: "Wait for the next complete state write, then rerun resolver.",
          },
          sourceStateDir: hftStateDir,
        }));
  const historicalFallbackAllowed = canUseHistoricalResolvedSymbol(resolvedSymbol);
  const quoteSymbol =
    resolvedSymbol.resolvedSymbol ||
    fallbackSnapshotSymbolForQuery(options.symbol ?? "tx-front") ||
    "TX00";
  const symbol = activeStrategySymbolForQuoteSymbol(quoteSymbol);
  const eventSymbols = new Set([quoteSymbol, symbol].filter(Boolean));
  const instCfg = INSTRUMENT_CONFIG[symbol] ?? INSTRUMENT_CONFIG["TX00"];
  const ticksPath = options.ticksPath ?? path.join(hftStateDir, "capital_quote_events.jsonl");
  const tradingDir = path.join(repoRoot, ".openclaw", "trading");
  const intentsPath =
    options.intentsPath ?? path.join(tradingDir, "capital-strategy-intents.jsonl");
  const reportPath =
    options.reportPath ?? path.join(tradingDir, "capital-strategy-engine-latest.json");
  const now = new Date();
  const intentRunId = crypto.randomUUID();

  if (!resolvedSymbol.ok && !historicalFallbackAllowed) {
    const intentLifecycle = options.appendIntents
      ? null
      : await clearIntentsWithLifecycle({
          intentsPath,
          intentRunId,
          status: "rejected",
          reason: "blocked_symbol_not_ready",
          generatedAt: now.toISOString(),
        });
    if (!options.appendIntents) {
      await fs.mkdir(path.dirname(intentsPath), { recursive: true });
    }
    const report = {
      schema: SCHEMA,
      generatedAt: now.toISOString(),
      status: "blocked_symbol_not_ready",
      ...baseSafetyFields(),
      symbol,
      quoteSymbol,
      resolver: resolvedSymbol,
      resolverReady: false,
      historicalFallbackUsed: false,
      source: {
        ticksPath,
        stateDir: hftStateDir,
        liveCallbackSource: ticksPath.includes("CapitalHftService"),
        intentRunId,
      },
      intentRunId,
      intentLifecycle,
      stats: { totalTicks: 0, barsBuilt: 0, signalsGenerated: 0, intentsWritten: 0 },
      safetyLock: safetyLock(),
    };
    await writeJsonWithSha(reportPath, report);
    return report;
  }

  // 讀取 tick 資料
  let rawLines = [];
  try {
    const raw = await fs.readFile(ticksPath, "utf8");
    rawLines = raw.split("\n").filter((l) => l.trim().length > 0);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
    const intentLifecycle = options.appendIntents
      ? null
      : await clearIntentsWithLifecycle({
          intentsPath,
          intentRunId,
          status: "rejected",
          reason: "no_ticks",
          generatedAt: now.toISOString(),
        });
    return {
      schema: SCHEMA,
      generatedAt: now.toISOString(),
      status: "no_ticks",
      ...baseSafetyFields(),
      symbol,
      quoteSymbol,
      resolver: resolvedSymbol,
      resolverReady: resolvedSymbol.ok === true,
      historicalFallbackUsed: resolvedSymbol.ok !== true && historicalFallbackAllowed,
      source: {
        ticksPath,
        stateDir: hftStateDir,
        liveCallbackSource: ticksPath.includes("CapitalHftService"),
        intentRunId,
      },
      intentRunId,
      intentLifecycle,
      stats: { totalTicks: 0, barsBuilt: 0, signalsGenerated: 0, intentsWritten: 0 },
      safetyLock: safetyLock(),
    };
  }

  // 建立 BarBuilder + 策略實例
  const barBuilder = new BarBuilder({ symbol, timeframeMinutes: 1 });
  const orbStrategy = new OrbStrategy({ orbMinutes: 30, riskRewardRatio: 1.5, stopPct: 0.5 });
  const emaStrategy = new EmaTrendStrategy({ fastPeriod: 5, slowPeriod: 20 });
  const vwapStrategy = new VwapMeanRevertStrategy({ deviationMult: 1.5 });

  const signals = [];
  const intents = [];
  const intentContext = {
    intentRunId,
    resolverReady: resolvedSymbol.ok === true,
    historicalFallbackUsed: resolvedSymbol.ok !== true && historicalFallbackAllowed,
  };
  let barsBuilt = 0;
  let totalTicks = 0;

  for (const line of rawLines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!eventSymbols.has(event.stockNo)) {
      continue;
    }
    totalTicks++;

    const completedBar = barBuilder.addTick(event);
    if (!completedBar) {
      continue;
    }
    barsBuilt++;

    const dayBars = barBuilder.getDaySessionBars();

    // 策略 1：ORB
    const orbSignal = orbStrategy.onBar(completedBar);
    if (orbSignal) {
      const intent = signalToIntent(orbSignal, symbol, now, instCfg, intentContext);
      signals.push({ ...orbSignal, intentId: intent.intentId });
      intents.push(intent);
    }

    // 策略 2：EMA 趨勢
    const emaSignal = emaStrategy.onBars(dayBars);
    if (emaSignal) {
      const intent = signalToIntent(emaSignal, symbol, now, instCfg, intentContext);
      signals.push({ ...emaSignal, intentId: intent.intentId });
      intents.push(intent);
    }

    // 策略 3：VWAP 均值回歸
    const vwapSignal = vwapStrategy.onBars(dayBars);
    if (vwapSignal) {
      const intent = signalToIntent(vwapSignal, symbol, now, instCfg, intentContext);
      signals.push({ ...vwapSignal, intentId: intent.intentId });
      intents.push(intent);
    }
  }

  // 目前 K 棒統計
  const allBars = barBuilder.getAllBars();
  const dayBars = barBuilder.getDaySessionBars();
  const lastBar = allBars[allBars.length - 1] ?? null;
  const highPrice = dayBars.length ? Math.max(...dayBars.map((b) => b.high)) : 0;
  const lowPrice = dayBars.length ? Math.min(...dayBars.map((b) => b.low)) : 0;

  // 寫入 intents（追加模式）
  let intentsWritten = 0;
  const engineStatus = resolvedSymbol.ok
    ? signals.length > 0
      ? "signals_generated"
      : "no_signals"
    : signals.length > 0
      ? "historical_signals_generated"
      : "historical_no_signals";
  let intentLifecycle = null;
  if (!options.appendIntents) {
    intentLifecycle = await clearIntentsWithLifecycle({
      intentsPath,
      intentRunId,
      status: intents.length > 0 ? "superseded" : "rejected",
      reason: intents.length > 0 ? "new_intent_epoch" : engineStatus,
      generatedAt: now.toISOString(),
    });
  }
  if (intents.length > 0) {
    await fs.mkdir(path.dirname(intentsPath), { recursive: true });
    for (const intent of intents) {
      await appendJsonLine(intentsPath, intent);
    }
    intentsWritten = intents.length;
  }

  // 寫入報告
  const report = {
    schema: SCHEMA,
    generatedAt: now.toISOString(),
    status: engineStatus,
    ...baseSafetyFields(),
    symbol,
    quoteSymbol,
    resolver: resolvedSymbol,
    resolverReady: resolvedSymbol.ok === true,
    historicalFallbackUsed: resolvedSymbol.ok !== true && historicalFallbackAllowed,
    instrument: instCfg.name,
    pointValue: instCfg.pointValue,
    source: {
      ticksPath,
      stateDir: hftStateDir,
      liveCallbackSource: ticksPath.includes("CapitalHftService"),
      intentRunId,
    },
    intentRunId,
    intentLifecycle,
    market: {
      lastPrice: lastBar?.close ?? 0,
      dayHigh: highPrice,
      dayLow: lowPrice,
      dayRange: Math.round((highPrice - lowPrice) * 10) / 10,
      daySessionBars: dayBars.length,
    },
    stats: {
      totalTicks,
      barsBuilt,
      signalsGenerated: signals.length,
      intentsWritten,
      byStrategy: {
        orb: signals.filter((s) => s.type?.startsWith("orb")).length,
        ema: signals.filter((s) => s.type?.startsWith("ema")).length,
        vwap: signals.filter((s) => s.type?.startsWith("vwap")).length,
      },
    },
    signals,
    safetyLock: safetyLock(),
  };

  await writeJsonWithSha(reportPath, report);
  return report;
}

// ─── CLI 入口 ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const result = await runStrategyEngine({
    repoRoot: flag("--repo-root"),
    ticksPath: flag("--ticks-path"),
    intentsPath: flag("--intents-path"),
    reportPath: flag("--report-path"),
    symbol: flag("--symbol"),
    appendIntents: args.includes("--append"),
  });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const s = result.stats;
    process.stdout.write(
      [
        `schema:           ${result.schema}`,
        `status:           ${result.status}`,
        `symbol:           ${result.symbol}`,
        `resolverReady:    ${result.resolverReady}`,
        `snapshotMode:     ${result.historicalFallbackUsed}`,
        `lastPrice:        ${result.market?.lastPrice}`,
        `dayRange:         ${result.market?.dayRange} pts`,
        `ticks:            ${s.totalTicks}`,
        `bars:             ${s.barsBuilt}`,
        `signals:          ${s.signalsGenerated}  (orb=${s.byStrategy?.orb} ema=${s.byStrategy?.ema} vwap=${s.byStrategy?.vwap})`,
        `intentsWritten:   ${s.intentsWritten}`,
      ].join("\n") + "\n",
    );

    if (result.signals?.length > 0) {
      process.stdout.write("\n--- 信號詳情 ---\n");
      result.signals.forEach((sig, i) => {
        process.stdout.write(
          `[${i + 1}] ${sig.type} direction=${sig.direction} entry=${sig.entryPrice} stop=${sig.stopPrice?.toFixed(0)} target=${sig.targetPrice?.toFixed(0)} conf=${sig.confidence}\n  ${sig.reason}\n`,
        );
      });
    }
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
