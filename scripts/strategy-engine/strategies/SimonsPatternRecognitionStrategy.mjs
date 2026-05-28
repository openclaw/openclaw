/**
 * SimonsPatternRecognitionStrategy.mjs — 西蒙斯非線性模式識別策略
 *
 * 靈感：Renaissance 使用核回歸 + 傅立葉分析識別隱藏價格模式
 * 原理：
 *   - 用加權核回歸（Nadaraya-Watson）擬合局部價格曲線
 *   - 計算價格與擬合值的殘差（偏離）
 *   - 用 FFT 簡化版偵測週期性模式
 *   - 偏離過大且有週期回歸特徵時進場
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class SimonsPatternRecognitionStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 8,
        slowPeriod: 21,
        // 核回歸
        kernelBandwidth: 8,
        kernelLookback: 40,
        // 殘差進出場
        residualEntry: 2.2,
        residualExit: 0.4,
        // 週期偵測
        cycleMinPeriod: 5,
        cycleMaxPeriod: 25,
        cycleStrengthThreshold: 0.6,
        // 風控
        maxHoldTicks: 400,
        cooldownMs: 12_000,
        minTicks: 50,
        ...config.params,
      },
    });
    this._holdTicks = 0;
  }

  eaTick(tick, _indicators) {
    const p = this.params;
    const prices = this._tickHistory.map((t) => t.price);
    const n = prices.length;
    if (n < p.kernelLookback + 10) {
      return null;
    }

    // ── 1. Nadaraya-Watson 核回歸 ──
    const window = prices.slice(-p.kernelLookback);
    const fitted = this._kernelRegression(window, p.kernelBandwidth);
    const lastFitted = fitted[fitted.length - 1];
    const residuals = window.map((v, i) => v - fitted[i]);

    // 殘差的標準差
    const resMean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const resStd = Math.sqrt(
      residuals.reduce((s, r) => s + (r - resMean) ** 2, 0) / residuals.length,
    );
    if (resStd === 0) {
      return null;
    }
    const zResidual = (tick.price - lastFitted) / resStd;

    // ── 2. 週期性偵測（自相關峰值法）──
    const cycleStrength = this._detectCycle(residuals, p.cycleMinPeriod, p.cycleMaxPeriod);

    // ── 3. 持倉計數 ──
    if (this._position !== 0) {
      this._holdTicks++;
    } else {
      this._holdTicks = 0;
    }

    // ── 4. 進場：殘差偏離 + 週期回歸特徵 ──
    const hasCycle = cycleStrength > p.cycleStrengthThreshold;

    if (this._position === 0 && hasCycle) {
      if (zResidual < -p.residualEntry) {
        return {
          action: "buy",
          reason: `Pattern多 zRes=${zResidual.toFixed(2)} cycle=${cycleStrength.toFixed(2)}`,
        };
      }
      if (zResidual > p.residualEntry) {
        return {
          action: "sell",
          reason: `Pattern空 zRes=${zResidual.toFixed(2)} cycle=${cycleStrength.toFixed(2)}`,
        };
      }
    }

    // ── 5. 出場 ──
    if (this._position !== 0) {
      if (Math.abs(zResidual) < p.residualExit) {
        return { action: "close", reason: `Pattern回歸平 zRes=${zResidual.toFixed(2)}` };
      }
      if (this._holdTicks > p.maxHoldTicks) {
        return { action: "close", reason: `Pattern超時 hold=${this._holdTicks}` };
      }
    }

    return null;
  }

  /** Nadaraya-Watson 高斯核回歸 */
  _kernelRegression(prices, bandwidth) {
    const n = prices.length;
    const fitted = Array.from({ length: n });
    for (let i = 0; i < n; i++) {
      let wSum = 0,
        vSum = 0;
      for (let j = 0; j < n; j++) {
        const dist = (i - j) / bandwidth;
        const w = Math.exp(-0.5 * dist * dist);
        wSum += w;
        vSum += w * prices[j];
      }
      fitted[i] = vSum / wSum;
    }
    return fitted;
  }

  /** 自相關峰值法偵測週期性強度 */
  _detectCycle(series, minP, maxP) {
    const n = series.length;
    if (n < maxP + 5) {
      return 0;
    }
    const mean = series.reduce((a, b) => a + b, 0) / n;
    const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    if (variance === 0) {
      return 0;
    }

    let maxCorr = 0;
    for (let lag = minP; lag <= maxP && lag < n - 5; lag++) {
      let corr = 0;
      for (let i = lag; i < n; i++) {
        corr += (series[i] - mean) * (series[i - lag] - mean);
      }
      corr /= (n - lag) * variance;
      if (corr > maxCorr) {
        maxCorr = corr;
      }
    }
    return maxCorr;
  }
}

export default SimonsPatternRecognitionStrategy;
