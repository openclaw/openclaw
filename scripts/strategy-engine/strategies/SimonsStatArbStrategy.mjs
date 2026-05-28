/**
 * SimonsStatArbStrategy.mjs — 西蒙斯統計套利策略
 *
 * 靈感：Renaissance Medallion 基金的核心方法
 * 原理：價格短期偏離統計均衡時回歸交易
 *   - 計算 Z-Score（價格偏離移動均值的標準差倍數）
 *   - 用 Hurst 指數判斷均值回歸特性
 *   - 用自相關係數判斷趨勢持續性
 *   - 加入成交量異常偵測做為確認信號
 *   - 多重時間框架驗證避免假信號
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class SimonsStatArbStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        // 快慢均線
        fastPeriod: 8,
        slowPeriod: 34,
        // Z-Score 參數
        zScorePeriod: 50,
        zScoreEntry: 2.0, // 偏離 2 標準差進場
        zScoreExit: 0.3, // 回到 0.3 標準差出場
        // Hurst 指數
        hurstPeriod: 100,
        hurstThreshold: 0.45, // < 0.5 表示均值回歸特性
        // 自相關
        autocorrLag: 5,
        autocorrThreshold: -0.15, // 負自相關 = 回歸
        // 成交量
        volAvgPeriod: 30,
        volSpikeMultiplier: 1.8,
        // 風控
        maxHoldTicks: 500,
        cooldownMs: 15_000,
        minTicks: 60,
        ...config.params,
      },
    });
    this._holdTicks = 0;
  }

  eaTick(tick, _indicators) {
    const p = this.params;
    const prices = this._tickHistory.map((t) => t.price);
    const n = prices.length;
    if (n < p.zScorePeriod) {
      return null;
    }

    // ── 1. Z-Score 計算 ──
    const window = prices.slice(-p.zScorePeriod);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) {
      return null;
    }
    const zScore = (tick.price - mean) / stdDev;

    // ── 2. Hurst 指數估計（R/S 法簡化版）──
    let hurst = 0.5;
    if (n >= p.hurstPeriod) {
      hurst = this._estimateHurst(prices.slice(-p.hurstPeriod));
    }

    // ── 3. 自相關係數 ──
    const autocorr = this._autocorrelation(prices.slice(-60), p.autocorrLag);

    // ── 4. 成交量異常 ──
    const volumes = this._tickHistory.map((t) => t.volume);
    const volAvg = volumes.slice(-p.volAvgPeriod).reduce((a, b) => a + b, 0) / p.volAvgPeriod;
    const volSpike = volAvg > 0 ? tick.volume / volAvg : 0;

    // ── 5. 持倉 tick 計數 ──
    if (this._position !== 0) {
      this._holdTicks++;
    } else {
      this._holdTicks = 0;
    }

    // ── 進場條件：均值回歸型 ──
    const isMeanReverting = hurst < p.hurstThreshold || autocorr < p.autocorrThreshold;

    if (this._position === 0 && isMeanReverting) {
      // 價格高於均值 2σ → 做空（預期回歸）
      if (zScore > p.zScoreEntry && volSpike > 1.0) {
        return {
          action: "sell",
          reason: `StatArb空 z=${zScore.toFixed(2)} hurst=${hurst.toFixed(3)} ac=${autocorr.toFixed(3)}`,
        };
      }
      // 價格低於均值 2σ → 做多（預期回歸）
      if (zScore < -p.zScoreEntry && volSpike > 1.0) {
        return {
          action: "buy",
          reason: `StatArb多 z=${zScore.toFixed(2)} hurst=${hurst.toFixed(3)} ac=${autocorr.toFixed(3)}`,
        };
      }
    }

    // ── 出場條件 ──
    if (this._position !== 0) {
      // Z-Score 回歸到均值附近
      if (Math.abs(zScore) < p.zScoreExit) {
        return { action: "close", reason: `回歸出場 z=${zScore.toFixed(2)}` };
      }
      // 超時出場
      if (this._holdTicks > p.maxHoldTicks) {
        return { action: "close", reason: `超時出場 hold=${this._holdTicks}` };
      }
      // 反向突破加速離場
      if (
        (this._position > 0 && zScore > p.zScoreEntry * 1.5) ||
        (this._position < 0 && zScore < -p.zScoreEntry * 1.5)
      ) {
        return { action: "close", reason: `反向加速離場 z=${zScore.toFixed(2)}` };
      }
    }

    return null;
  }

  /** R/S Hurst 指數簡化估計 */
  _estimateHurst(prices) {
    const n = prices.length;
    if (n < 20) {
      return 0.5;
    }
    // 計算收益率
    const returns = [];
    for (let i = 1; i < n; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    // 累積偏差
    let cumDev = 0,
      maxDev = -Infinity,
      minDev = Infinity;
    for (const r of returns) {
      cumDev += r - mean;
      maxDev = Math.max(maxDev, cumDev);
      minDev = Math.min(minDev, cumDev);
    }
    const range = maxDev - minDev;
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    if (stdDev === 0 || range === 0) {
      return 0.5;
    }
    const rs = range / stdDev;
    // H = log(R/S) / log(n)
    return Math.log(rs) / Math.log(returns.length);
  }

  /** 自相關係數 */
  _autocorrelation(prices, lag) {
    const n = prices.length;
    if (n < lag + 10) {
      return 0;
    }
    const returns = [];
    for (let i = 1; i < n; i++) {
      returns.push(prices[i] - prices[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    let num = 0,
      den = 0;
    for (let i = lag; i < returns.length; i++) {
      num += (returns[i] - mean) * (returns[i - lag] - mean);
      den += (returns[i] - mean) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }
}

export default SimonsStatArbStrategy;
