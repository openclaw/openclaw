/**
 * EaBaseStrategy.mjs — EA（Expert Advisor）策略基底
 * 類似 MT4/MT5 EA：每個 tick 即時運算指標、判斷進出場
 * 特性：
 *   - onTick() 為主要決策點（不等 bar 完成）
 *   - 內建技術指標計算（SMA/EMA/RSI/MACD/ATR/BB）
 *   - 即時 SL/TP + trailing stop（繼承自 BaseStrategy）
 *   - 冷卻期（cooldown）避免頻繁交易
 *   - 部位管理 + 加碼邏輯
 */
import { BaseStrategy } from "../BaseStrategy.mjs";

export class EaBaseStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // tick 歷史（用於 tick 級指標）
    this._tickHistory = [];
    this._maxTicks = this.params.maxTicks ?? 2000;
    // 冷卻期
    this._cooldownMs = this.params.cooldownMs ?? 30_000; // 30 秒
    this._lastTradeTime = 0;
    // 指標快取
    this._indicators = {};
  }

  /**
   * EA 核心：每個 tick 觸發
   * 子類必須 override eaTick(tick, indicators) 實作交易邏輯
   */
  onTick(event) {
    // 先執行 BaseStrategy 的 SL/TP/trailing 檢查
    super.onTick(event);
    // 如果已經被停損/停利出場，不再處理
    if (this._position === 0 && this._lastSignal?.direction?.startsWith("close")) return;

    const price = event?.price ?? 0;
    if (price <= 0) return;

    // 記錄 tick
    this._tickHistory.push({
      price,
      volume: event?.volume ?? 0,
      time: event?.time ?? new Date(),
      ts: Date.now(),
    });
    if (this._tickHistory.length > this._maxTicks) {
      this._tickHistory.shift();
    }

    // 最少要 N 個 tick 才開始運算
    const minTicks = this.params.minTicks ?? 20;
    if (this._tickHistory.length < minTicks) return;

    // 冷卻期檢查
    if (Date.now() - this._lastTradeTime < this._cooldownMs) return;

    // 計算指標
    const prices = this._tickHistory.map((t) => t.price);
    const indicators = this._calcIndicators(prices);

    // 呼叫子類邏輯
    const decision = this.eaTick(
      { price, volume: event?.volume ?? 0, time: event?.time },
      indicators,
    );
    if (!decision) return;

    // 執行決策
    if (decision.action === "buy" && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", decision.reason, this.maxQty);
      }
      this.signal("buy", decision.reason, decision.qty ?? this.maxQty);
      this._position = 1;
      this._entryPrice = price;
      this._highSinceEntry = price;
      this._lastTradeTime = Date.now();
    } else if (decision.action === "sell" && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", decision.reason, this.maxQty);
      }
      this.signal("sell", decision.reason, decision.qty ?? this.maxQty);
      this._position = -1;
      this._entryPrice = price;
      this._lowSinceEntry = price;
      this._lastTradeTime = Date.now();
    } else if (decision.action === "close") {
      const dir = this._position > 0 ? "close_long" : "close_short";
      this.signal(dir, decision.reason, this.maxQty);
      this._resetPosition();
      this._lastTradeTime = Date.now();
    }
  }

  /**
   * 子類 override 此方法實作 EA 邏輯
   * @returns {{ action: "buy"|"sell"|"close"|null, reason: string, qty?: number } | null}
   */
  eaTick(tick, indicators) {
    return null; // 子類實作
  }

  // ── 指標引擎 ─────────────────────────────────────────
  _calcIndicators(prices) {
    const n = prices.length;
    const p = this.params;
    return {
      price: prices[n - 1],
      sma_fast: this._sma(prices, p.fastPeriod ?? 10),
      sma_slow: this._sma(prices, p.slowPeriod ?? 30),
      ema_fast: this._ema(prices, p.fastPeriod ?? 10),
      ema_slow: this._ema(prices, p.slowPeriod ?? 30),
      rsi: this._rsi(prices, p.rsiPeriod ?? 14),
      macd: this._macd(prices, p.macdFast ?? 12, p.macdSlow ?? 26, p.macdSignal ?? 9),
      atr: this._atr(this._tickHistory, p.atrPeriod ?? 14),
      bb: this._bollingerBands(prices, p.bbPeriod ?? 20, p.bbStdDev ?? 2.0),
    };
  }

  _sma(arr, n) {
    if (arr.length < n) return arr[arr.length - 1] ?? 0;
    const slice = arr.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / n;
  }

  _ema(arr, n) {
    if (arr.length < n) return arr[arr.length - 1] ?? 0;
    const k = 2 / (n + 1);
    let ema = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < arr.length; i++) {
      ema = arr[i] * k + ema * (1 - k);
    }
    return ema;
  }

  _rsi(arr, n) {
    if (arr.length < n + 1) return 50;
    let avgGain = 0,
      avgLoss = 0;
    for (let i = arr.length - n; i < arr.length; i++) {
      const diff = arr[i] - arr[i - 1];
      if (diff > 0) avgGain += diff;
      else avgLoss -= diff;
    }
    avgGain /= n;
    avgLoss /= n;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  _macd(arr, fast, slow, signal) {
    const emaFast = this._ema(arr, fast);
    const emaSlow = this._ema(arr, slow);
    const macdLine = emaFast - emaSlow;
    // 簡化 signal line：用最近 signal 個 MACD 值的 EMA
    const macdArr = [];
    const k = 2 / (fast + 1);
    const kSlow = 2 / (slow + 1);
    let ef = arr.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
    let es = arr.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
    for (let i = Math.max(fast, slow); i < arr.length; i++) {
      ef = arr[i] * k + ef * (1 - k);
      es = arr[i] * kSlow + es * (1 - kSlow);
      macdArr.push(ef - es);
    }
    const signalLine = macdArr.length >= signal ? this._ema(macdArr, signal) : macdLine;
    return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
  }

  _atr(ticks, n) {
    if (ticks.length < n + 1) return 0;
    let sum = 0;
    for (let i = ticks.length - n; i < ticks.length; i++) {
      sum += Math.abs(ticks[i].price - ticks[i - 1].price);
    }
    return sum / n;
  }

  _bollingerBands(arr, n, stdDevMult) {
    const sma = this._sma(arr, n);
    const slice = arr.slice(-n);
    const variance = slice.reduce((sum, v) => sum + (v - sma) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    return {
      upper: sma + stdDevMult * stdDev,
      middle: sma,
      lower: sma - stdDevMult * stdDev,
      stdDev,
    };
  }
}

export default EaBaseStrategy;
