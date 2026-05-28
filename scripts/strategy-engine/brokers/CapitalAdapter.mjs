import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
/**
 * CapitalAdapter.mjs — 群益 CapitalHftService 券商 Adapter
 * 實作 BrokerAdapter 介面，對接 CapitalHftService C# 服務
 * 支援：台股、台期、海期（全商品）
 */
import { BrokerAdapter } from "./BrokerAdapter.mjs";

const HFT_DIR =
  process.env.CAPITAL_HFT_DIR ??
  (existsSync("D:\\群益及元大API\\CapitalHftService")
    ? "D:\\群益及元大API\\CapitalHftService"
    : "");
const STATE_DIR = path.join(HFT_DIR, "state");
const EVENTS_LOG = path.join(STATE_DIR, "capital_quote_events.jsonl");
const LATEST_EVT = path.join(STATE_DIR, "capital_latest_quote_event.json");
const OS_LATEST = path.join(STATE_DIR, "os_latest_quote_event.json");

// os_symbol_cache 在根目錄，不在 state/
const OS_CACHE = path.join(HFT_DIR, "os_symbol_cache.json");
// 台股報價快取
const STOCK_CACHE = path.join(HFT_DIR, "stock_symbol_cache.json");
// 台期報價快取
const TW_FUTURES_CACHE = path.join(HFT_DIR, "tw_futures_cache.json");
const DOM_RIGHTS = path.join(HFT_DIR, "hft_rights.json");
const OS_RIGHTS = path.join(HFT_DIR, "hft_os_rights.json");

const CMD_FILE = path.join(STATE_DIR, "hft_command.json");
const UI_STATE = path.join(HFT_DIR, ".openclaw", "ui", "capital-hft-service-state.json");
const POSITION_EPSILON = 1e-10;
const MAX_FRESH_MS = 600_000; // 10 分鐘

export class CapitalAdapter extends BrokerAdapter {
  constructor(opts = {}) {
    super({
      name: "capital",
      displayName: "群益 CapitalHftService",
      mode: opts.mode ?? "paper",
      markets: ["tw_stock", "domestic_futures", "overseas_futures"],
      ...opts,
    });
    this._paperPositions = [];
    this._paperOrders = [];
    this._nextOrderId = 1;
    // 快取
    this._osCacheData = null;
    this._osCacheTs = 0;
    this._stockCacheData = null;
    this._stockCacheTs = 0;
  }

  // ── 報價 ──────────────────────────────────────────────────────────

  async getQuote(symbol) {
    // 1. 嘗試海期 os_symbol_cache（最完整）
    const osQuote = this._getFromOsCache(symbol);
    if (osQuote) {
      return osQuote;
    }

    // 2. 嘗試台股 stock_symbol_cache
    const stockQuote = this._getFromStockCache(symbol);
    if (stockQuote) {
      return stockQuote;
    }

    // 3. 嘗試台期 tw_futures_cache
    const twfQuote = this._getFromTwFuturesCache(symbol);
    if (twfQuote) {
      return twfQuote;
    }

    // 4. 回退：最新事件檔（單一商品）
    return this._getFromLatestEvent(symbol);
  }

  _refreshOsCache() {
    if (Date.now() - this._osCacheTs < 2000) {
      return;
    } // 2秒快取
    try {
      if (!existsSync(OS_CACHE)) {
        return;
      }
      const raw = readFileSync(OS_CACHE, "utf-8").trim();
      this._osCacheData = JSON.parse(raw);
      this._osCacheTs = Date.now();
    } catch {
      /* ignore */
    }
  }

  _getFromOsCache(symbol) {
    this._refreshOsCache();
    const cache = this._osCacheData;
    if (!cache) {
      return null;
    }

    // 新鮮度檢查
    const genAt = cache.generatedAt;
    if (genAt) {
      const age = Date.now() - new Date(genAt).getTime();
      if (age > MAX_FRESH_MS) {
        return null;
      }
    }

    const symbols = cache.symbols ?? {};
    // 完全匹配 → 模糊匹配
    let entry = symbols[symbol] ?? symbols[symbol + "00"] ?? symbols[symbol + "0000"];
    if (!entry) {
      const upper = symbol.toUpperCase();
      for (const [k, v] of Object.entries(symbols)) {
        if (k.toUpperCase().startsWith(upper) || k.toUpperCase() === upper) {
          entry = v;
          break;
        }
      }
    }
    if (!entry || !(Number(entry.price) > 0)) {
      return null;
    }

    return {
      source: this.name + "_os_cache",
      symbol: entry.symbol ?? symbol,
      name: entry.name ?? "",
      price: Number(entry.price),
      bid: Number(entry.bid ?? 0) || null,
      ask: Number(entry.ask ?? 0) || null,
      volume: Number(entry.qty ?? 0),
      time: entry.time ?? new Date().toISOString(),
    };
  }

  _refreshStockCache() {
    if (Date.now() - this._stockCacheTs < 2000) {
      return;
    }
    try {
      if (!existsSync(STOCK_CACHE)) {
        return;
      }
      const raw = readFileSync(STOCK_CACHE, "utf-8").trim();
      this._stockCacheData = JSON.parse(raw);
      this._stockCacheTs = Date.now();
    } catch {
      /* ignore */
    }
  }

  _getFromStockCache(symbol) {
    this._refreshStockCache();
    const cache = this._stockCacheData;
    if (!cache) {
      return null;
    }

    const genAt = cache.generatedAt;
    if (genAt && Date.now() - new Date(genAt).getTime() > MAX_FRESH_MS) {
      return null;
    }

    const symbols = cache.symbols ?? cache.stocks ?? {};
    const entry = symbols[symbol];
    if (!entry || !(Number(entry.price ?? entry.close) > 0)) {
      return null;
    }

    return {
      source: this.name + "_stock_cache",
      symbol: entry.symbol ?? symbol,
      name: entry.name ?? "",
      price: Number(entry.price ?? entry.close),
      bid: Number(entry.bid ?? 0) || null,
      ask: Number(entry.ask ?? 0) || null,
      volume: Number(entry.qty ?? entry.volume ?? 0),
      time: entry.time ?? new Date().toISOString(),
    };
  }

  _getFromTwFuturesCache(symbol) {
    // 台期可能也在 os_symbol_cache 或專用快取
    try {
      if (!existsSync(TW_FUTURES_CACHE)) {
        return null;
      }
      const raw = readFileSync(TW_FUTURES_CACHE, "utf-8").trim();
      const cache = JSON.parse(raw);
      if (cache.generatedAt && Date.now() - new Date(cache.generatedAt).getTime() > MAX_FRESH_MS) {
        return null;
      }

      const symbols = cache.symbols ?? {};
      const entry = symbols[symbol];
      if (!entry || !(Number(entry.price ?? entry.close) > 0)) {
        return null;
      }

      return {
        source: this.name + "_tw_futures",
        symbol: entry.symbol ?? symbol,
        name: entry.name ?? "",
        price: Number(entry.price ?? entry.close),
        bid: Number(entry.bid ?? 0) || null,
        ask: Number(entry.ask ?? 0) || null,
        volume: Number(entry.qty ?? entry.volume ?? 0),
        time: entry.time ?? new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async _getFromLatestEvent(symbol) {
    try {
      const isOverseas = /^[A-Z]{2,4}\d{4}/.test(symbol);
      const fp = isOverseas ? OS_LATEST : LATEST_EVT;
      if (!existsSync(fp)) {
        return { source: this.name, symbol, error: "no_data" };
      }
      const raw = await fs.readFile(fp, "utf-8");
      const ev = JSON.parse(raw);
      const dec = Number.parseInt(ev.decimal ?? 2, 10);
      const factor = 10 ** dec;
      return {
        source: this.name + "_latest_event",
        symbol: ev.stockNo ?? symbol,
        name: ev.stockName ?? "",
        price: Number.parseFloat(ev.close ?? 0) / factor,
        bid: Number.parseFloat(ev.bid ?? 0) / factor || null,
        ask: Number.parseFloat(ev.ask ?? 0) / factor || null,
        volume: Number.parseInt(ev.qty ?? 0, 10),
        time: ev.receivedAt ?? new Date().toISOString(),
      };
    } catch {
      return { source: this.name, symbol, error: "read_failed" };
    }
  }

  async getBars(symbol, opts = {}) {
    const limit = opts.limit ?? 100;
    try {
      if (!existsSync(EVENTS_LOG)) {
        return [];
      }
      const raw = await fs.readFile(EVENTS_LOG, "utf-8");
      const lines = raw.trim().split("\n").slice(-limit);
      return lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async listInstruments() {
    const instruments = [];
    // 海期
    this._refreshOsCache();
    if (this._osCacheData?.symbols) {
      for (const [k, v] of Object.entries(this._osCacheData.symbols)) {
        instruments.push({
          symbol: k,
          name: v.name ?? "",
          type: "overseas_futures",
          exchange: "overseas",
        });
      }
    }
    // 台股
    this._refreshStockCache();
    if (this._stockCacheData?.symbols) {
      for (const [k, v] of Object.entries(this._stockCacheData.symbols)) {
        instruments.push({ symbol: k, name: v.name ?? "", type: "tw_stock", exchange: "TWSE" });
      }
    }
    // 台期（從 events log）
    if (existsSync(EVENTS_LOG)) {
      try {
        const seen = new Set(instruments.map((i) => i.symbol));
        const raw = await fs.readFile(EVENTS_LOG, "utf-8");
        for (const line of raw.split("\n").slice(-5000)) {
          try {
            const ev = JSON.parse(line);
            if (ev.stockNo && !seen.has(ev.stockNo)) {
              seen.add(ev.stockNo);
              instruments.push({
                symbol: ev.stockNo,
                name: ev.stockName ?? "",
                type: "domestic_futures",
                exchange: "TAIFEX",
              });
            }
          } catch {}
        }
      } catch {}
    }
    return instruments;
  }

  // ── 下單 ──────────────────────────────────────────────────────────

  async submitOrder(signal) {
    const safety = this.validateOrderSafety(signal);
    if (!safety.ok) {
      return { orderId: null, status: "rejected", ...safety };
    }
    const dayTradeMode = String(signal?.dayTradeMode ?? signal?.holdingMode ?? "day_trade")
      .toLowerCase()
      .replace(/[-\s]/gu, "_");
    const normalizedMode = dayTradeMode === "overnight" ? "overnight" : "day_trade";

    if (this.isPaper) {
      const orderId = `CAP-PAPER-${this._nextOrderId++}`;
      const fill = {
        orderId,
        status: "paper_filled",
        filledPrice: signal.price ?? 0,
        filledQty: signal.qty ?? 1,
        message: `紙上成交 ${signal.side} ${signal.symbol} x${signal.qty ?? 1}`,
      };
      this._paperOrders.push({ ...signal, ...fill, time: new Date().toISOString() });
      this._updatePaperPosition(signal, fill);
      return fill;
    }

    // Live：寫入 hft_command.json
    const cmd = {
      action: signal.side,
      symbol: signal.symbol,
      qty: signal.qty ?? 1,
      type: signal.type ?? "market",
      dayTradeMode: normalizedMode,
      dayTrade: normalizedMode === "day_trade",
      sDayTrade: normalizedMode === "day_trade" ? 1 : 0,
      price: signal.price,
      strategy: signal.strategy,
      timestamp: new Date().toISOString(),
      submitted: false,
    };
    await fs.writeFile(CMD_FILE, JSON.stringify(cmd, null, 2), "utf-8");
    return {
      orderId: `CAP-CMD-${Date.now()}`,
      status: "pending_execution",
      message: "已寫入 hft_command.json",
    };
  }

  async cancelOrder(orderId) {
    if (orderId.startsWith("CAP-PAPER-")) {
      const idx = this._paperOrders.findIndex((o) => o.orderId === orderId);
      if (idx >= 0) {
        this._paperOrders.splice(idx, 1);
      }
      return { ok: true, message: `紙上訂單 ${orderId} 已取消` };
    }
    return { ok: false, message: "群益 live 取消需透過 CapitalHftService" };
  }

  async getPositions() {
    return this._paperPositions;
  }

  async getAccountSummary() {
    const parseNullableNumber = (value) => {
      const numeric = Number.parseFloat(String(value ?? ""));
      return Number.isFinite(numeric) ? numeric : null;
    };
    try {
      const domRaw = await fs.readFile(DOM_RIGHTS, "utf-8");
      const dom = JSON.parse(domRaw);
      const osRaw = await fs.readFile(OS_RIGHTS, "utf-8");
      const os = JSON.parse(osRaw);
      return {
        equity: parseNullableNumber(dom.rights),
        margin: parseNullableNumber(dom.margin),
        available: parseNullableNumber(dom.availableBalance),
        osEquity: parseNullableNumber(os.rights),
        osMargin: parseNullableNumber(os.margin),
        osAvailable: parseNullableNumber(os.availableBalance),
        currency: "TWD",
        osCurrency: "USD",
        source: "hft_rights_json",
        updatedAt: dom.generatedAt ?? os.generatedAt ?? null,
      };
    } catch {
      return {
        equity: null,
        margin: null,
        available: null,
        currency: "TWD",
        note: this.isPaper ? "紙上模式，無真實帳戶資訊" : "需透過 CapitalHftService 查詢",
      };
    }
  }

  async healthCheck() {
    try {
      const h = JSON.parse(await fs.readFile(UI_STATE, "utf-8"));
      if (h.running === true && h.loginStatus === "connected") {
        return true;
      }
    } catch {}
    this._refreshOsCache();
    if (this._osCacheData?.generatedAt) {
      const age = Date.now() - new Date(this._osCacheData.generatedAt).getTime();
      if (age < MAX_FRESH_MS) {
        return true;
      }
    }
    try {
      const ev = JSON.parse(await fs.readFile(LATEST_EVT, "utf-8"));
      return ev.receivedAt && Date.now() - new Date(ev.receivedAt).getTime() < MAX_FRESH_MS;
    } catch {
      return false;
    }
  }

  getAllCachedQuotes() {
    const result = {};
    this._refreshOsCache();
    if (this._osCacheData?.symbols) {
      for (const [k, v] of Object.entries(this._osCacheData.symbols)) {
        if (Number(v.price) > 0) {
          result[k] = { price: Number(v.price), volume: Number(v.qty ?? 0), time: v.time };
        }
      }
    }
    this._refreshStockCache();
    if (this._stockCacheData?.symbols) {
      for (const [k, v] of Object.entries(this._stockCacheData.symbols)) {
        const p = Number(v.price ?? v.close);
        if (p > 0) {
          result[k] = { price: p, volume: Number(v.qty ?? v.volume ?? 0), time: v.time };
        }
      }
    }
    return result;
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
