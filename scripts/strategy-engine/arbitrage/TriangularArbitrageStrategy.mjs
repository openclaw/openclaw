// TriangularArbitrageStrategy.mjs — 三角套利（加密貨幣）
// 移植自：https://github.com/bmino/binance-triangle-arbitrage
// 邏輯：
//   路徑: USDT → BTC → ETH → USDT
//   理論終值 = (1 / BTC_USDT_ask) * (ETH_BTC_bid) * (ETH_USDT_bid)
//   若終值 > 1 + fee*3 → 存在三角套利機會
//
//   路徑 B: USDT → ETH → BTC → USDT
//   理論終值 = (1 / ETH_USDT_ask) * (1 / ETH_BTC_ask) * BTC_USDT_bid
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { appendFileSync } from "node:fs";

const ARB_LOG = "D:\\群益及元大API\\CapitalHftService\\state\\hft_triangular_arb.jsonl";

export class TriangularArbitrageStrategy {
  constructor(config) {
    this.name = config.name;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? false;
    this._enabled = true;
    this._signals = [];

    // 三角組合，預設 USDT→BTC→ETH→USDT
    this.triA = this.params.triA ?? "BTC/USDT"; // USDT→BTC
    this.triB = this.params.triB ?? "ETH/BTC"; // BTC→ETH
    this.triC = this.params.triC ?? "ETH/USDT"; // ETH→USDT
    this.exchangeId = this.params.exchangeId ?? "okx";
    this.feePct = this.params.feePct ?? 0.001; // 單邊手續費
    this.minProfit = this.params.minProfit ?? 0.002; // 最低利潤門檻 0.2%
    this.cooldownSec = this.params.cooldownSec ?? 60;
    this._lastTradeAt = 0;
    this._exchange = null;
    this._initExchange();
  }

  _initExchange() {
    try {
      const ccxt = require("ccxt");
      const Ex = ccxt[this.exchangeId];
      if (Ex) {
        this._exchange = new Ex({
          apiKey: this.params.apiKey ?? "",
          secret: this.params.secret ?? "",
          sandbox: this.params.sandbox ?? true,
        });
      }
    } catch (e) {
      console.warn("[TriangularArb] ccxt 初始化失敗:", e.message);
    }
  }

  async scan() {
    if (!this._exchange) {
      return;
    }
    if (Date.now() - this._lastTradeAt < this.cooldownSec * 1000) {
      return;
    }

    try {
      const [tA, tB, tC] = await Promise.all([
        this._exchange.fetchTicker(this.triA),
        this._exchange.fetchTicker(this.triB),
        this._exchange.fetchTicker(this.triC),
      ]);

      const fee3 = this.feePct * 3;

      // ── 路徑 1: USDT → BTC → ETH → USDT ──────────
      // 用 USDT 買 BTC: 1/tA.ask 個 BTC
      // 用 BTC 買 ETH: × tB.bid 個 ETH
      // 賣 ETH 換 USDT: × tC.bid 個 USDT
      const profit1 = (1 / tA.ask) * tB.bid * tC.bid - 1 - fee3;

      // ── 路徑 2: USDT → ETH → BTC → USDT ──────────
      // 用 USDT 買 ETH: 1/tC.ask 個 ETH
      // 用 ETH 買 BTC: × (1/tB.ask) 個 BTC
      // 賣 BTC 換 USDT: × tA.bid 個 USDT
      const profit2 = (1 / tC.ask) * (1 / tB.ask) * tA.bid - 1 - fee3;

      const bestProfit = Math.max(profit1, profit2);
      const path = profit1 > profit2 ? 1 : 2;

      if (bestProfit > this.minProfit) {
        const route =
          path === 1
            ? `USDT→BTC@${tA.ask}→ETH@${tB.bid}→USDT@${tC.bid}`
            : `USDT→ETH@${tC.ask}→BTC@${tB.ask}→USDT@${tA.bid}`;
        const reason = `三角套利 路徑${path} 理論利潤=${(bestProfit * 100).toFixed(3)}% ${route}`;
        console.log(`[TriArb] 💰 ${reason}`);

        this._signals.push({
          time: new Date().toISOString(),
          type: "triangular",
          strategy: this.name,
          direction: "triangular",
          reason,
          path,
          profit: bestProfit,
          autoExecute: this.autoExecute,
          legs:
            path === 1
              ? [
                  { action: "buy", symbol: this.triA, price: tA.ask },
                  { action: "buy", symbol: this.triB, price: tB.ask },
                  { action: "sell", symbol: this.triC, price: tC.bid },
                ]
              : [
                  { action: "buy", symbol: this.triC, price: tC.ask },
                  { action: "sell", symbol: this.triB, price: tB.bid },
                  { action: "sell", symbol: this.triA, price: tA.bid },
                ],
        });

        try {
          appendFileSync(
            ARB_LOG,
            JSON.stringify({ time: new Date().toISOString(), path, profit: bestProfit, route }) +
              "\n",
          );
        } catch {}
        this._lastTradeAt = Date.now();
      }
    } catch {}
  }

  popSignals() {
    const s = [...this._signals];
    this._signals = [];
    return s;
  }
  get enabled() {
    return this._enabled;
  }
}
