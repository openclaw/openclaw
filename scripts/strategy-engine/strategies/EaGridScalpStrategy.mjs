/**
 * EaGridScalpStrategy — 網格 + 剝頭皮混合 EA
 * 每隔固定 ATR 倍數建網格，碰到網格線就進場反向交易
 * 適合震盪行情、高流動性商品
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaGridScalpStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        cooldownMs: 5_000,
        stopLoss: 1.5,
        takeProfit: 1.0,
        trailActivate: 0.6,
        trailStop: 0.3,
        minTicks: 50,
        ...config.params,
      },
    });
    this._gridMultiplier = this.params.gridMultiplier ?? 2.0; // ATR 倍數作為網格間距
    this._lastGridLevel = 0;
  }

  eaTick(tick, ind) {
    const { atr, price, bb } = ind;
    if (atr <= 0) return null;

    const gridSize = atr * this._gridMultiplier;
    if (gridSize <= 0) return null;

    // 計算當前所在網格
    const gridLevel = Math.round(price / gridSize);

    // 首次設定
    if (this._lastGridLevel === 0) {
      this._lastGridLevel = gridLevel;
      return null;
    }

    // 跨越網格線
    if (gridLevel !== this._lastGridLevel) {
      const direction = gridLevel > this._lastGridLevel ? "up" : "down";
      this._lastGridLevel = gridLevel;

      // 在布林通道內：均值回歸（逆勢）
      if (price < bb.upper && price > bb.lower) {
        if (direction === "up" && this._position !== -1) {
          return {
            action: "sell",
            reason: `網格逆勢空 lv=${gridLevel} grid=${gridSize.toFixed(2)}`,
          };
        }
        if (direction === "down" && this._position !== 1) {
          return {
            action: "buy",
            reason: `網格逆勢多 lv=${gridLevel} grid=${gridSize.toFixed(2)}`,
          };
        }
      } else {
        // 在通道外：趨勢跟進
        if (direction === "up" && price > bb.upper && this._position !== 1) {
          return { action: "buy", reason: `網格突破多 lv=${gridLevel}` };
        }
        if (direction === "down" && price < bb.lower && this._position !== -1) {
          return { action: "sell", reason: `網格突破空 lv=${gridLevel}` };
        }
      }
    }
    return null;
  }
}

export default EaGridScalpStrategy;
