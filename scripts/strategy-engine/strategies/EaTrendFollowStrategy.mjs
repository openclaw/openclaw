/**
 * EaTrendFollowStrategy — 趨勢追蹤 EA
 * 多重均線排列 + RSI 趨勢確認 + ATR 動態停損
 * 適合中長線趨勢商品（期貨、加密貨幣）
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaTrendFollowStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 10,
        slowPeriod: 30,
        rsiPeriod: 14,
        cooldownMs: 60_000, // 1 分鐘冷卻
        stopLoss: 3.0,
        takeProfit: 8.0,
        trailActivate: 3.0,
        trailStop: 1.5,
        ...config.params,
      },
    });
    this._trendPeriod = this.params.trendPeriod ?? 50;
  }

  eaTick(tick, ind) {
    const { ema_fast, ema_slow, rsi, atr, price } = ind;
    const prices = this._tickHistory.map((t) => t.price);
    const sma_trend = this._sma(prices, this._trendPeriod);

    // 趨勢判斷：三線排列
    const bullTrend = ema_fast > ema_slow && ema_slow > sma_trend && price > ema_fast;
    const bearTrend = ema_fast < ema_slow && ema_slow < sma_trend && price < ema_fast;

    // RSI 確認趨勢方向
    const rsiBull = rsi > 50 && rsi < 80;
    const rsiBear = rsi < 50 && rsi > 20;

    // 進場
    if (bullTrend && rsiBull && this._position !== 1) {
      return { action: "buy", reason: `趨勢多 三線多排 RSI=${rsi.toFixed(1)}` };
    }
    if (bearTrend && rsiBear && this._position !== -1) {
      return { action: "sell", reason: `趨勢空 三線空排 RSI=${rsi.toFixed(1)}` };
    }

    // 趨勢反轉出場
    if (this._position === 1 && ema_fast < ema_slow) {
      return { action: "close", reason: `均線死叉 趨勢反轉 平多` };
    }
    if (this._position === -1 && ema_fast > ema_slow) {
      return { action: "close", reason: `均線金叉 趨勢反轉 平空` };
    }
    return null;
  }
}

export default EaTrendFollowStrategy;
