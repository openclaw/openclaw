// TradingAgentsStrategy.mjs — 接入 TauricResearch/TradingAgents 多代理 LLM 框架
// 繼承 BaseStrategy，透過 HTTP 橋接呼叫 Python 服務取得 BUY/SELL/HOLD 信號
import http from "node:http";
import { BaseStrategy } from "../BaseStrategy.mjs";

export class TradingAgentsStrategy extends BaseStrategy {
  constructor(config = {}) {
    super(config);
    this._serviceHost = this.params.serviceHost || "127.0.0.1";
    this._servicePort = this.params.servicePort || 8390;
    this._ticker = this.params.ticker || this.instrument;
    this._fallbackTicker = this.params.fallbackTicker || this._ticker;
    this._analysisBars = Number.isFinite(Number(this.params.analysisBars))
      ? Math.max(3, Math.trunc(Number(this.params.analysisBars)))
      : 20;
    this._cooldownMs = this.params.cooldownMs || 300000;
    this._minConfidence = Number.isFinite(Number(this.params.minConfidence))
      ? Number(this.params.minConfidence)
      : 0.55;
    this._qty = Number.isFinite(Number(this.params.qty)) ? Number(this.params.qty) : this.maxQty;
    this._lastCallTime = 0;
    this._pending = false;
    this._dirMap = { BUY: "buy", OVERWEIGHT: "buy", SELL: "sell", UNDERWEIGHT: "sell" };
  }

  onBar(bar) {
    this.addBar(bar);
    const now = Date.now();
    if (now - this._lastCallTime < this._cooldownMs) {
      return;
    }
    if (this._pending) {
      return;
    }
    this._pending = true;
    this._lastCallTime = now;
    this._analyze(bar)
      .catch((err) => {
        console.error("[TradingAgents] " + this.name + ": " + err.message);
      })
      .finally(() => {
        this._pending = false;
      });
  }

  onTick(event) {
    if (!event || event.type !== "tick") {
      return;
    }
    const now = Date.now();
    if (now - this._lastCallTime < this._cooldownMs) {
      return;
    }
    if (this._pending) {
      return;
    }
    this._pending = true;
    this._lastCallTime = now;
    this._analyze({
      open: event.price || 0,
      high: event.price || 0,
      low: event.price || 0,
      close: event.price || 0,
      volume: event.volume || 0,
      time: event.time ? new Date(event.time).toISOString() : new Date().toISOString(),
    })
      .catch((err) => {
        console.error("[TradingAgents] " + this.name + ": " + err.message);
      })
      .finally(() => {
        this._pending = false;
      });
  }

  async _analyze(bar) {
    const normalizedBar = this._normalizeBar(bar);
    const recentBars = this._priceHistory
      .slice(-this._analysisBars)
      .map((item) => this._normalizeBar(item));
    const eventTime = bar?.time || new Date().toISOString();
    const parsed = new Date(eventTime);
    const safeTime = Number.isFinite(parsed.getTime()) ? parsed : new Date();
    const payload = JSON.stringify({
      ticker: this._ticker,
      fallbackTicker: this._fallbackTicker,
      instrument: this.instrument,
      broker: this.broker,
      marketDataSource: this.broker,
      trade_date: safeTime.toISOString().slice(0, 10),
      asOf: safeTime.toISOString(),
      price: normalizedBar.close,
      volume: normalizedBar.volume,
      currentBar: normalizedBar,
      recentBars,
    });
    const result = await this._post("/analyze", payload);
    if (!result || result.error) {
      return;
    }
    if (result.noOrderWrite !== true || result.brokerWriteAttempted === true) {
      return;
    }
    if (Number(result.confidence ?? 0) < this._minConfidence) {
      return;
    }
    const rawSignal = (result.signal || "").toUpperCase().trim();
    const direction = this._dirMap[rawSignal];
    if (!direction) {
      return;
    }
    this.signal(direction, result.reason || "TradingAgents: " + rawSignal, this._qty);
  }

  _normalizeBar(bar = {}) {
    const price = this._toFinite(bar.close ?? bar.price ?? 0, 0);
    return {
      open: this._toFinite(bar.open ?? price, price),
      high: this._toFinite(bar.high ?? price, price),
      low: this._toFinite(bar.low ?? price, price),
      close: price,
      volume: this._toFinite(bar.volume ?? 0, 0),
      time: bar.time || new Date().toISOString(),
    };
  }

  _toFinite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  _post(urlPath, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this._serviceHost,
          port: this._servicePort,
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 120000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error("Invalid JSON"));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });
  }
}
