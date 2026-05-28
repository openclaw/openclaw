/**
 * SimonsMomentumDecayStrategy.mjs — 西蒙斯動量衰減策略
 *
 * 靈感：Renaissance 觀察到動量有半衰期，會在特定時間尺度反轉
 * 原理：
 *   - 多時間尺度動量分解（ultra-short / short / medium）
 *   - 計算動量衰減率（半衰期估計）
 *   - 當短期動量極強但衰減信號出現 → 反向交易
 *   - 當短中期動量一致且未衰減 → 跟隨趨勢
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class SimonsMomentumDecayStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 5,
        slowPeriod: 21,
        // 多尺度動量
        ultraShortPeriod: 3,
        shortPeriod: 8,
        mediumPeriod: 21,
        // 衰減偵測
        decayLookback: 15,
        decayThreshold: 0.6, // 衰減率 > 60% 視為反轉信號
        // 進場
        momentumStrength: 0.003, // 動量絕對值門檻
        alignmentBonus: 1.5, // 多尺度一致加乘
        // 風控
        maxHoldTicks: 300,
        cooldownMs: 10_000,
        minTicks: 30,
        ...config.params,
      },
    });
    this._holdTicks = 0;
    this._momHistory = [];
  }

  eaTick(tick, indicators) {
    const p = this.params;
    const prices = this._tickHistory.map((t) => t.price);
    const n = prices.length;
    if (n < p.mediumPeriod + p.decayLookback) return null;

    // ── 1. 多尺度動量 ──
    const momUltra = this._momentum(prices, p.ultraShortPeriod);
    const momShort = this._momentum(prices, p.shortPeriod);
    const momMed = this._momentum(prices, p.mediumPeriod);

    // ── 2. 動量衰減率 ──
    this._momHistory.push(momShort);
    if (this._momHistory.length > p.decayLookback * 2) this._momHistory.shift();
    const decayRate = this._estimateDecay(this._momHistory, p.decayLookback);

    // ── 3. 多尺度一致性 ──
    const aligned =
      Math.sign(momUltra) === Math.sign(momShort) && Math.sign(momShort) === Math.sign(momMed);

    // ── 4. 持倉計數 ──
    if (this._position !== 0) this._holdTicks++;
    else this._holdTicks = 0;

    // ── 5. 策略邏輯 ──
    if (this._position === 0) {
      // 模式 A: 動量衰減反轉
      if (Math.abs(momShort) > p.momentumStrength && decayRate > p.decayThreshold) {
        // 動量正在衰減 → 反向
        if (momShort > 0) {
          return {
            action: "sell",
            reason: `MomDecay反轉空 mom=${(momShort * 100).toFixed(3)}% decay=${(decayRate * 100).toFixed(0)}%`,
          };
        } else {
          return {
            action: "buy",
            reason: `MomDecay反轉多 mom=${(momShort * 100).toFixed(3)}% decay=${(decayRate * 100).toFixed(0)}%`,
          };
        }
      }

      // 模式 B: 多尺度動量一致 + 未衰減 → 跟隨
      if (
        aligned &&
        Math.abs(momShort) > p.momentumStrength * p.alignmentBonus &&
        decayRate < 0.3
      ) {
        if (momShort > 0) {
          return {
            action: "buy",
            reason: `MomAlign多 mom=${(momShort * 100).toFixed(3)}% aligned decay=${(decayRate * 100).toFixed(0)}%`,
          };
        } else {
          return {
            action: "sell",
            reason: `MomAlign空 mom=${(momShort * 100).toFixed(3)}% aligned decay=${(decayRate * 100).toFixed(0)}%`,
          };
        }
      }
    }

    // ── 6. 出場 ──
    if (this._position !== 0) {
      // 動量翻轉
      if (
        (this._position > 0 && momUltra < 0 && momShort < 0) ||
        (this._position < 0 && momUltra > 0 && momShort > 0)
      ) {
        return { action: "close", reason: `MomDecay翻轉平 momU=${(momUltra * 100).toFixed(3)}%` };
      }
      if (this._holdTicks > p.maxHoldTicks) {
        return { action: "close", reason: `MomDecay超時 hold=${this._holdTicks}` };
      }
    }

    return null;
  }

  _momentum(prices, period) {
    const n = prices.length;
    if (n < period + 1) return 0;
    return (prices[n - 1] - prices[n - 1 - period]) / prices[n - 1 - period];
  }

  /** 動量衰減率估計（用近期 vs 遠期動量絕對值比較）*/
  _estimateDecay(momHistory, lookback) {
    const n = momHistory.length;
    if (n < lookback) return 0;
    const recent = momHistory.slice(-Math.floor(lookback / 2));
    const earlier = momHistory.slice(-lookback, -Math.floor(lookback / 2));

    const recentAvg = recent.reduce((a, b) => a + Math.abs(b), 0) / recent.length;
    const earlierAvg = earlier.reduce((a, b) => a + Math.abs(b), 0) / earlier.length;

    if (earlierAvg === 0) return 0;
    const ratio = recentAvg / earlierAvg;
    // ratio < 1 表示動量在衰減；轉換為 0~1 衰減率
    return Math.max(0, Math.min(1, 1 - ratio));
  }
}

export default SimonsMomentumDecayStrategy;
