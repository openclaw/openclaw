/**
 * EaScalpingStrategy — 高頻剝頭皮 EA
 * 極短期均線交叉 + ATR 過濾 + 快速停利
 * 適合高流動性商品（BTC、ES、NQ、台指）
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaScalpingStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 5,
        slowPeriod: 15,
        cooldownMs: 10_000, // 10 秒冷卻
        stopLoss: 0.5, // 0.5% 停損
        takeProfit: 0.8, // 0.8% 停利
        trailActivate: 0.5,
        trailStop: 0.3,
        minTicks: 30,
        ...config.params,
      },
    });
    this._atrFilter = this.params.atrFilter ?? 0.001; // ATR 最低門檻（過濾盤整）
  }

  eaTick(tick, ind) {
    const { ema_fast, ema_slow, atr, rsi, price } = ind;

    // ATR 過濾：波動太小不交易
    if (atr < this._atrFilter * price) return null;

    // RSI 過濾：不在極端區域逆勢
    const neutralZone = rsi > 35 && rsi < 65;

    // 快線穿越慢線 → 即時進場
    const crossUp = ema_fast > ema_slow;
    const crossDown = ema_fast < ema_slow;
    const spread = (Math.abs(ema_fast - ema_slow) / price) * 100;

    // 需要有足夠差距才進場（避免假訊號）
    if (spread < 0.01) return null;

    if (crossUp && this._position !== 1 && neutralZone) {
      return { action: "buy", reason: `Scalp多 EMA↑ spread=${spread.toFixed(3)}%` };
    }
    if (crossDown && this._position !== -1 && neutralZone) {
      return { action: "sell", reason: `Scalp空 EMA↓ spread=${spread.toFixed(3)}%` };
    }
    return null;
  }
}

export default EaScalpingStrategy;
