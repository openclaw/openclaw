/**
 * QuoteHub.mjs — 毫秒級即時報價中心
 *
 * 架構：
 *   OKX WebSocket ──┐
 *                    ├──→ 記憶體 Map (quotes) ──→ getQuote() < 0.01ms
 *   Capital fswatch ─┘         │
 *                              └──→ EventEmitter → 策略引擎
 *
 * 取代舊的 JSON 檔案輪詢，報價延遲從 1-3 秒降到 < 50ms
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import WebSocket from "ws";

// ═══════════════════════════════════════════════════════════════
// 常數
// ═══════════════════════════════════════════════════════════════
const OKX_WS_PUBLIC = "wss://ws.okx.com:8443/ws/v5/public";
const _OKX_WS_BUSINESS = "wss://ws.okx.com:8443/ws/v5/business";
const HFT_DIR =
  process.env.CAPITAL_HFT_DIR ??
  (existsSync("D:\\群益及元大API\\CapitalHftService")
    ? "D:\\群益及元大API\\CapitalHftService"
    : "");
const OS_CACHE_PATH = path.join(HFT_DIR, "os_symbol_cache.json");
const STOCK_CACHE_PATH = path.join(HFT_DIR, "stock_symbol_cache.json");
const HEARTBEAT_INTERVAL = 25_000; // OKX ping 間隔
const RECONNECT_DELAY = 3_000;
const MAX_FRESH_MS = 600_000;

// ═══════════════════════════════════════════════════════════════
// QuoteHub 主體
// ═══════════════════════════════════════════════════════════════
export class QuoteHub extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(2000); // 1620 策略
    // 記憶體報價快取：symbol → { price, bid, ask, volume, time, source, updatedAt }
    this._quotes = new Map();
    this._okxWs = null;
    this._okxPingTimer = null;
    this._okxReconnectTimer = null;
    this._capitalWatchers = [];
    this._running = false;
    this._stats = { okxTicks: 0, capitalTicks: 0, totalQueries: 0, startedAt: null };
    this._okxSubscribedChannels = new Set();
    this._verbose = opts.verbose ?? false;
  }

  // ─── 啟動 ──────────────────────────────────────────────────────
  async start(instruments = []) {
    this._running = true;
    this._stats.startedAt = Date.now();

    // 分類商品
    const okxSpot = [];
    const okxSwap = [];
    const okxOther = [];
    const capitalSymbols = [];

    for (const inst of instruments) {
      const sym = typeof inst === "string" ? inst : (inst.instrument ?? inst.symbol);
      if (!sym) {
        continue;
      }
      if (sym.includes("-USDT-SWAP") || sym.includes("-USD-SWAP")) {
        okxSwap.push(sym);
      } else if (sym.includes("-USDT") || sym.includes("-USD")) {
        okxSpot.push(sym);
      } else {
        capitalSymbols.push(sym);
      }
    }

    // 1. Capital：啟動檔案監聽 + 初始載入
    this._startCapitalWatcher();
    this._loadCapitalCache(); // 初始載入

    // 2. OKX：WebSocket 連線
    if (okxSpot.length > 0 || okxSwap.length > 0) {
      await this._connectOkxWs([...okxSpot, ...okxSwap, ...okxOther]);
    }

    if (this._verbose) {
      console.log(
        `[QuoteHub] Started: ${capitalSymbols.length} capital, ${okxSpot.length} okx-spot, ${okxSwap.length} okx-swap`,
      );
    }
  }

  stop() {
    this._running = false;
    // 關閉 OKX WebSocket
    if (this._okxWs) {
      this._okxWs.close();
      this._okxWs = null;
    }
    clearInterval(this._okxPingTimer);
    clearTimeout(this._okxReconnectTimer);
    // 關閉 Capital 監聽
    for (const w of this._capitalWatchers) {
      w.close();
    }
    this._capitalWatchers = [];
  }

  // ─── 報價查詢（< 0.01ms，純記憶體）──────────────────────────
  getQuote(symbol) {
    this._stats.totalQueries++;
    return this._quotes.get(symbol) ?? this._quotes.get(symbol.toUpperCase()) ?? null;
  }

  getPrice(symbol) {
    return this.getQuote(symbol)?.price ?? null;
  }

  // 批次取得
  getQuotes(symbols) {
    const result = {};
    for (const s of symbols) {
      const q = this.getQuote(s);
      if (q) {
        result[s] = q;
      }
    }
    return result;
  }

  // 全部報價快照
  snapshot() {
    const out = {};
    for (const [k, v] of this._quotes) {
      out[k] = { ...v };
    }
    return out;
  }

  get quoteCount() {
    return this._quotes.size;
  }
  get stats() {
    return {
      ...this._stats,
      quoteCount: this._quotes.size,
      uptime: Date.now() - (this._stats.startedAt ?? Date.now()),
    };
  }

  // ─── 內部：更新報價 ─────────────────────────────────────────
  _update(symbol, data) {
    const now = Date.now();
    const existing = this._quotes.get(symbol);
    const quote = {
      symbol,
      price: data.price,
      bid: data.bid ?? existing?.bid ?? null,
      ask: data.ask ?? existing?.ask ?? null,
      volume: data.volume ?? existing?.volume ?? 0,
      time: data.time ?? new Date().toISOString(),
      source: data.source ?? "unknown",
      updatedAt: now,
    };
    this._quotes.set(symbol, quote);
    // 發送事件給訂閱者（策略引擎）
    this.emit("tick", quote);
    this.emit(`tick:${symbol}`, quote);
  }

  // ═══════════════════════════════════════════════════════════════
  // OKX WebSocket
  // ═══════════════════════════════════════════════════════════════
  async _connectOkxWs(instruments) {
    return new Promise((resolve) => {
      try {
        this._okxWs = new WebSocket(OKX_WS_PUBLIC);
      } catch (err) {
        console.error("[QuoteHub] OKX WS create error:", err.message);
        this._scheduleOkxReconnect(instruments);
        resolve();
        return;
      }

      this._okxWs.on("open", () => {
        if (this._verbose) {
          console.log("[QuoteHub] OKX WebSocket connected");
        }
        // 訂閱 tickers（分批，每批 100）
        this._subscribeOkxTickers(instruments);
        // 心跳
        this._okxPingTimer = setInterval(() => {
          if (this._okxWs?.readyState === WebSocket.OPEN) {
            this._okxWs.send("ping");
          }
        }, HEARTBEAT_INTERVAL);
        resolve();
      });

      this._okxWs.on("message", (raw) => {
        let str = "";
        if (typeof raw === "string") {
          str = raw;
        } else if (raw instanceof ArrayBuffer) {
          str = Buffer.from(raw).toString("utf-8");
        } else if (ArrayBuffer.isView(raw)) {
          str = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf-8");
        } else if (Array.isArray(raw)) {
          str = Buffer.concat(raw).toString("utf-8");
        } else {
          return;
        }
        if (str === "pong") {
          return;
        }
        try {
          const msg = JSON.parse(str);
          if (msg.data && msg.arg?.channel === "tickers") {
            for (const d of msg.data) {
              this._stats.okxTicks++;
              this._update(d.instId, {
                price: Number(d.last),
                bid: Number(d.bidPx),
                ask: Number(d.askPx),
                volume: Number(d.vol24h),
                time: new Date(Number(d.ts)).toISOString(),
                source: "okx_ws",
              });
            }
          }
        } catch {}
      });

      this._okxWs.on("close", () => {
        if (this._verbose) {
          console.log("[QuoteHub] OKX WebSocket closed");
        }
        clearInterval(this._okxPingTimer);
        if (this._running) {
          this._scheduleOkxReconnect(instruments);
        }
      });

      this._okxWs.on("error", (err) => {
        console.error("[QuoteHub] OKX WS error:", err.message);
      });
    });
  }

  _subscribeOkxTickers(instruments) {
    // 分批訂閱，每批 100 個
    const batchSize = 100;
    for (let i = 0; i < instruments.length; i += batchSize) {
      const batch = instruments.slice(i, i + batchSize);
      const args = batch.map((instId) => ({ channel: "tickers", instId }));
      if (this._okxWs?.readyState === WebSocket.OPEN) {
        this._okxWs.send(JSON.stringify({ op: "subscribe", args }));
      }
    }
    if (this._verbose) {
      console.log(`[QuoteHub] OKX subscribed ${instruments.length} tickers`);
    }
  }

  _scheduleOkxReconnect(instruments) {
    if (!this._running) {
      return;
    }
    this._okxReconnectTimer = setTimeout(() => {
      if (this._verbose) {
        console.log("[QuoteHub] OKX reconnecting...");
      }
      void this._connectOkxWs(instruments);
    }, RECONNECT_DELAY);
  }

  // ═══════════════════════════════════════════════════════════════
  // Capital 檔案監聽（fs.watch）
  // ═══════════════════════════════════════════════════════════════
  _startCapitalWatcher() {
    if (!HFT_DIR || !existsSync(HFT_DIR)) {
      return;
    }

    // 監聽 os_symbol_cache.json 變更
    if (existsSync(OS_CACHE_PATH)) {
      try {
        const watcher = watch(OS_CACHE_PATH, { persistent: false }, (eventType) => {
          if (eventType === "change") {
            this._loadOsCache();
          }
        });
        this._capitalWatchers.push(watcher);
      } catch {}
    }

    // 監聽 stock_symbol_cache.json 變更
    if (existsSync(STOCK_CACHE_PATH)) {
      try {
        const watcher = watch(STOCK_CACHE_PATH, { persistent: false }, (eventType) => {
          if (eventType === "change") {
            this._loadStockCache();
          }
        });
        this._capitalWatchers.push(watcher);
      } catch {}
    }

    // 也監聽整個 state 目錄的事件檔
    const stateDir = path.join(HFT_DIR, "state");
    if (existsSync(stateDir)) {
      try {
        const watcher = watch(stateDir, { persistent: false }, (eventType, filename) => {
          if (filename?.includes("latest_quote_event")) {
            this._loadLatestEvent(filename);
          }
        });
        this._capitalWatchers.push(watcher);
      } catch {}
    }
  }

  _loadCapitalCache() {
    this._loadOsCache();
    this._loadStockCache();
  }

  _loadOsCache() {
    try {
      if (!existsSync(OS_CACHE_PATH)) {
        return;
      }
      const raw = readFileSync(OS_CACHE_PATH, "utf-8").trim();
      const cache = JSON.parse(raw);
      if (cache.generatedAt) {
        const age = Date.now() - new Date(cache.generatedAt).getTime();
        if (age > MAX_FRESH_MS) {
          return;
        }
      }
      const symbols = cache.symbols ?? {};
      let count = 0;
      for (const [k, v] of Object.entries(symbols)) {
        const price = Number(v.price);
        if (price > 0) {
          this._stats.capitalTicks++;
          count++;
          this._update(k, {
            price,
            bid: Number(v.bid ?? 0) || null,
            ask: Number(v.ask ?? 0) || null,
            volume: Number(v.qty ?? 0),
            time: v.time,
            source: "capital_os_cache",
          });
        }
      }
      if (this._verbose && count > 0) {
        console.log(`[QuoteHub] Capital OS cache: ${count} quotes loaded`);
      }
    } catch {}
  }

  _loadStockCache() {
    try {
      if (!existsSync(STOCK_CACHE_PATH)) {
        return;
      }
      const raw = readFileSync(STOCK_CACHE_PATH, "utf-8").trim();
      const cache = JSON.parse(raw);
      if (cache.generatedAt && Date.now() - new Date(cache.generatedAt).getTime() > MAX_FRESH_MS) {
        return;
      }
      const symbols = cache.symbols ?? cache.stocks ?? {};
      let count = 0;
      for (const [k, v] of Object.entries(symbols)) {
        const price = Number(v.price ?? v.close);
        if (price > 0) {
          this._stats.capitalTicks++;
          count++;
          this._update(k, {
            price,
            bid: Number(v.bid ?? 0) || null,
            ask: Number(v.ask ?? 0) || null,
            volume: Number(v.qty ?? v.volume ?? 0),
            time: v.time,
            source: "capital_stock_cache",
          });
        }
      }
      if (this._verbose && count > 0) {
        console.log(`[QuoteHub] Capital stock cache: ${count} quotes loaded`);
      }
    } catch {}
  }

  _loadLatestEvent(filename) {
    try {
      const fp = path.join(HFT_DIR, "state", filename);
      if (!existsSync(fp)) {
        return;
      }
      const raw = readFileSync(fp, "utf-8").trim();
      const ev = JSON.parse(raw);
      const dec = Number.parseInt(ev.decimal ?? 2, 10);
      const factor = 10 ** dec;
      const symbol = ev.stockNo;
      if (!symbol) {
        return;
      }
      const price = Number.parseFloat(ev.close ?? 0) / factor;
      if (price <= 0) {
        return;
      }
      this._stats.capitalTicks++;
      this._update(symbol, {
        price,
        bid: Number.parseFloat(ev.bid ?? 0) / factor || null,
        ask: Number.parseFloat(ev.ask ?? 0) / factor || null,
        volume: Number.parseInt(ev.qty ?? 0, 10),
        time: ev.receivedAt,
        source: "capital_event",
      });
    } catch {}
  }

  // ─── 整合 DataFeed ─────────────────────────────────────────
  /**
   * 將 QuoteHub 接入 StrategyEngine 的 DataFeed
   * 每次 tick 自動 pushTick 到 feed
   */
  bridgeToFeed(feed) {
    this.on("tick", (quote) => {
      // 判斷 broker
      const broker = quote.source?.startsWith("capital")
        ? "capital"
        : quote.source?.startsWith("okx")
          ? "okx"
          : "unknown";
      feed.pushTick(quote.symbol, broker, quote.price, {
        volume: quote.volume ?? 0,
        time: quote.time ? new Date(quote.time) : new Date(),
      });
    });
  }
}

export default QuoteHub;
