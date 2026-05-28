/**
 * OkxAdapter.mjs — OKX 券商 Adapter
 * 實作 BrokerAdapter 介面，對接 OKX REST API v5
 * 報價用公開端點（免 key），下單用 demo API
 */
import { BrokerAdapter } from "./BrokerAdapter.mjs";

const OKX_BASE = "https://www.okx.com";
const POSITION_EPSILON = 1e-10;

export class OkxAdapter extends BrokerAdapter {
  constructor(opts = {}) {
    super({
      name: "okx",
      displayName: "OKX Exchange",
      mode: opts.mode ?? "demo",
      markets: ["crypto_spot", "crypto_swap", "crypto_futures"],
      ...opts,
    });
    this._apiKey = opts.apiKey ?? null;
    this._secretKey = opts.secretKey ?? null;
    this._passphrase = opts.passphrase ?? null;
    this._isDemo = opts.mode !== "live";
    this._paperPositions = [];
    this._paperOrders = [];
    this._nextOrderId = 1;
  }

  async getQuote(symbol) {
    const instId = this._normalizeInstId(symbol);
    const url = `${OKX_BASE}/api/v5/market/ticker?instId=${instId}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await resp.json();
    const d = json.data?.[0];
    if (!d) {
      return { source: this.name, symbol, error: "no_data" };
    }
    return {
      source: this.name,
      symbol: instId,
      price: Number.parseFloat(d.last),
      bid: Number.parseFloat(d.bidPx),
      ask: Number.parseFloat(d.askPx),
      volume: Number.parseFloat(d.vol24h),
      time: new Date(Number.parseInt(d.ts, 10)).toISOString(),
    };
  }

  async getBars(symbol, opts = {}) {
    const instId = this._normalizeInstId(symbol);
    const bar = opts.interval ?? "1m";
    const limit = opts.limit ?? 100;
    const url = `${OKX_BASE}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const json = await resp.json();
    if (!json.data) {
      return [];
    }
    return json.data
      .map((k) => ({
        time: new Date(Number.parseInt(k[0], 10)).toISOString(),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        source: this.name,
      }))
      .toReversed();
  }

  async listInstruments() {
    const results = [];
    for (const instType of ["SPOT", "SWAP", "FUTURES"]) {
      try {
        const url = `${OKX_BASE}/api/v5/public/instruments?instType=${instType}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const json = await resp.json();
        if (json.data) {
          for (const inst of json.data) {
            results.push({
              symbol: inst.instId,
              name: `${inst.baseCcy ?? ""}-${inst.quoteCcy ?? ""}`,
              type: `crypto_${instType.toLowerCase()}`,
              exchange: "OKX",
            });
          }
        }
      } catch {}
    }
    return results;
  }

  async submitOrder(signal) {
    const safety = this.validateOrderSafety(signal);
    if (!safety.ok) {
      return { orderId: null, status: "rejected", ...safety };
    }

    if (this.mode === "demo" && this._apiKey) {
      return {
        orderId: null,
        status: "demo_pending",
        message: "OKX demo 下單需人工確認。請在 OpenClaw 控制台確認後執行。",
      };
    }

    if (this.mode === "paper" || (this.mode === "demo" && !this._apiKey)) {
      const orderId = `OKX-PAPER-${this._nextOrderId++}`;
      const fill = {
        orderId,
        status: "paper_filled",
        filledPrice: signal.price ?? 0,
        filledQty: signal.qty ?? 1,
        message: `OKX 紙上成交 ${signal.side} ${signal.symbol} x${signal.qty ?? 1}`,
      };
      this._paperOrders.push({ ...signal, ...fill, time: new Date().toISOString() });
      this._updatePaperPosition(signal, fill);
      return fill;
    }

    return { orderId: null, status: "rejected", message: "無可用的 OKX API 金鑰或模式" };
  }

  async cancelOrder(orderId) {
    if (orderId.startsWith("OKX-PAPER-")) {
      this._paperOrders = this._paperOrders.filter((o) => o.orderId !== orderId);
      return { ok: true, message: `OKX 紙上訂單 ${orderId} 已取消` };
    }
    return { ok: false, message: "OKX demo/live 取消需透過 API" };
  }

  async getPositions() {
    return this._paperPositions;
  }

  async getAccountSummary() {
    if (this.mode === "paper") {
      return { equity: null, margin: null, available: null, currency: "USDT", note: "紙上模式" };
    }
    return {
      equity: null,
      margin: null,
      available: null,
      currency: "USDT",
      note: "需 demo API 金鑰查詢",
    };
  }

  async healthCheck() {
    try {
      const url = `${OKX_BASE}/api/v5/public/time`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = await resp.json();
      return json.code === "0";
    } catch {
      return false;
    }
  }

  _normalizeInstId(symbol) {
    const s = symbol.toUpperCase().replace(/[/]/g, "-");
    if (s.includes("-")) {
      return s;
    }
    if (s.endsWith("USDT")) {
      return s.replace("USDT", "") + "-USDT";
    }
    return s + "-USDT";
  }

  _updatePaperPosition(signal, fill) {
    const existing = this._paperPositions.find((p) => p.symbol === signal.symbol);
    const side = String(signal.side ?? "").toLowerCase();
    const fillQty = Number(fill.filledQty ?? signal.qty ?? 0);
    const fillPrice = Number(fill.filledPrice ?? signal.price ?? 0);
    const signedFillQty = fillQty * (side === "buy" ? 1 : -1);
    if (!Number.isFinite(signedFillQty) || Math.abs(signedFillQty) < POSITION_EPSILON) {
      return;
    }

    if (!existing) {
      this._paperPositions.push({
        symbol: signal.symbol,
        side: signedFillQty > 0 ? "buy" : "sell",
        qty: Math.abs(signedFillQty),
        avgPrice: fillPrice,
        unrealizedPnl: 0,
      });
      return;
    }

    const existingSignedQty =
      Math.abs(Number(existing.qty ?? 0)) *
      (String(existing.side ?? "").toLowerCase() === "sell" ? -1 : 1);
    const nextSignedQty = existingSignedQty + signedFillQty;
    if (Math.abs(nextSignedQty) < POSITION_EPSILON) {
      this._paperPositions = this._paperPositions.filter((p) => p.symbol !== signal.symbol);
      return;
    }

    const sameDirection = Math.sign(existingSignedQty) === Math.sign(signedFillQty);
    if (sameDirection) {
      const totalQty = Math.abs(existingSignedQty) + Math.abs(signedFillQty);
      existing.avgPrice =
        totalQty > 0
          ? (Number(existing.avgPrice ?? 0) * Math.abs(existingSignedQty) +
              fillPrice * Math.abs(signedFillQty)) /
            totalQty
          : fillPrice;
    } else if (Math.sign(nextSignedQty) === Math.sign(signedFillQty)) {
      existing.avgPrice = fillPrice;
    }
    existing.side = nextSignedQty > 0 ? "buy" : "sell";
    existing.qty = Math.abs(nextSignedQty);
  }
}
