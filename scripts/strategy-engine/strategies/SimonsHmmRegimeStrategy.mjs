/**
 * SimonsHmmRegimeStrategy.mjs — 西蒙斯隱馬可夫模型市場狀態策略
 *
 * 靈感：Renaissance 使用 HMM 識別市場隱藏狀態
 * 原理：
 *   - 用波動率 + 動量 + 成交量將市場分為 3 個隱藏狀態
 *     state 0: 低波動趨勢（跟隨趨勢）
 *     state 1: 高波動震盪（均值回歸）
 *     state 2: 極端波動/危機（減倉/反向）
 *   - 根據當前狀態選擇最佳策略
 *   - 狀態轉移矩陣自適應更新
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class SimonsHmmRegimeStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 8,
        slowPeriod: 21,
        // 狀態判斷
        volLookback: 30,
        volLowThreshold: 0.3, // 低波動百分位
        volHighThreshold: 0.85, // 高波動百分位
        momentumPeriod: 10,
        // 趨勢跟隨參數（state 0）
        trendMaFast: 5,
        trendMaSlow: 15,
        // 均值回歸參數（state 1）
        revertZEntry: 1.5,
        revertZExit: 0.2,
        // 危機參數（state 2）
        crisisVolMultiple: 3.0,
        // 狀態歷史
        stateHistoryLen: 50,
        cooldownMs: 10_000,
        minTicks: 40,
        ...config.params,
      },
    });
    this._stateHistory = []; // 狀態歷史
    this._volHistory = []; // 波動率歷史
    this._currentState = -1;
  }

  eaTick(tick, indicators) {
    const p = this.params;
    const prices = this._tickHistory.map((t) => t.price);
    const n = prices.length;
    if (n < p.volLookback + 10) return null;

    // ── 1. 計算即時波動率（用 tick 收益率標準差）──
    const returns = [];
    for (let i = n - p.volLookback; i < n; i++) {
      returns.push(Math.abs(prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    const currentVol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
    this._volHistory.push(currentVol);
    if (this._volHistory.length > 200) this._volHistory.shift();

    // ── 2. 波動率百分位（在歷史中的位置）──
    const sortedVol = [...this._volHistory].sort((a, b) => a - b);
    const volPercentile =
      sortedVol.indexOf(
        sortedVol.reduce((closest, v) =>
          Math.abs(v - currentVol) < Math.abs(closest - currentVol) ? v : closest,
        ),
      ) / sortedVol.length;

    // ── 3. 動量 ──
    const momWindow = prices.slice(-p.momentumPeriod);
    const momentum = (momWindow[momWindow.length - 1] - momWindow[0]) / momWindow[0];

    // ── 4. 判斷市場狀態 ──
    let state;
    if (volPercentile > p.volHighThreshold) {
      state = 2; // 極端波動
    } else if (volPercentile < p.volLowThreshold) {
      state = 0; // 低波動趨勢
    } else {
      state = 1; // 中波動震盪
    }
    this._currentState = state;
    this._stateHistory.push(state);
    if (this._stateHistory.length > p.stateHistoryLen) this._stateHistory.shift();

    // ── 5. 狀態轉移偵測 ──
    const prevState =
      this._stateHistory.length > 1 ? this._stateHistory[this._stateHistory.length - 2] : state;
    const stateChanged = state !== prevState;

    // ── 6. 根據狀態執行策略 ──

    // State 0: 低波動 → 趨勢跟隨
    if (state === 0) {
      const maFast = this._sma(prices, p.trendMaFast);
      const maSlow = this._sma(prices, p.trendMaSlow);

      if (this._position === 0) {
        if (maFast > maSlow && momentum > 0) {
          return {
            action: "buy",
            reason: `HMM趨勢多 state=0 vol%=${(volPercentile * 100).toFixed(0)} mom=${(momentum * 100).toFixed(2)}%`,
          };
        }
        if (maFast < maSlow && momentum < 0) {
          return {
            action: "sell",
            reason: `HMM趨勢空 state=0 vol%=${(volPercentile * 100).toFixed(0)} mom=${(momentum * 100).toFixed(2)}%`,
          };
        }
      }
    }

    // State 1: 中波動 → 均值回歸
    if (state === 1) {
      const window = prices.slice(-p.volLookback);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const std = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
      const z = std > 0 ? (tick.price - mean) / std : 0;

      if (this._position === 0) {
        if (z < -p.revertZEntry) {
          return {
            action: "buy",
            reason: `HMM回歸多 state=1 z=${z.toFixed(2)} vol%=${(volPercentile * 100).toFixed(0)}`,
          };
        }
        if (z > p.revertZEntry) {
          return {
            action: "sell",
            reason: `HMM回歸空 state=1 z=${z.toFixed(2)} vol%=${(volPercentile * 100).toFixed(0)}`,
          };
        }
      }
      if (this._position !== 0 && Math.abs(z) < p.revertZExit) {
        return { action: "close", reason: `HMM回歸平 z=${z.toFixed(2)}` };
      }
    }

    // State 2: 極端波動 → 強制平倉 + 等待
    if (state === 2 && this._position !== 0) {
      return {
        action: "close",
        reason: `HMM危機平倉 state=2 vol%=${(volPercentile * 100).toFixed(0)}`,
      };
    }

    // 狀態轉移時平倉
    if (stateChanged && this._position !== 0) {
      return { action: "close", reason: `狀態轉移平倉 ${prevState}→${state}` };
    }

    return null;
  }
}

export default SimonsHmmRegimeStrategy;
