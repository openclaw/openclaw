/**
 * openclaw-multi-source-quote-router.mjs
 * 多源報價路由 + 自動故障切換
 * 優先: CapitalHftService (國內) -> OsQuoteFeed (海外) -> Binance (加密) -> TWSE (台股) -> Yahoo (備援)
 *
 * 用法:
 *   import { QuoteRouter } from './openclaw-multi-source-quote-router.mjs';
 *   const router = new QuoteRouter();
 *   const quote = await router.getQuote('TX00');
 *   const bars  = await router.getBars('ES=F', { interval: '1m', limit: 100 });
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const CAPITAL_HFT = "D:\\群益及元大API\\CapitalHftService";
const CAPITAL_HFT_STATE = path.join(CAPITAL_HFT, "state");
// 讀取 HFT 服務狀態：優先從根目錄（CapitalHftService 即時寫入），fallback 到 .openclaw/ui（可能過時）
const CAPITAL_HFT_STATUS_ROOT = path.join(CAPITAL_HFT, "hft_service_status.json");
const CAPITAL_HFT_UI = CAPITAL_HFT_STATUS_ROOT;
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");
const REGISTRY_FILE = path.join(ROOT, "config", "instrument-registry.json");

// 載入統一商品註冊表（快取）
let _registryCache = null;
async function loadRegistry() {
  if (_registryCache) return _registryCache;
  try {
    _registryCache = JSON.parse(await fs.readFile(REGISTRY_FILE, "utf8"));
  } catch {
    _registryCache = { sources: {} };
  }
  return _registryCache;
}

// === SkcomSource (CapitalHftService) ===
class SkcomSource {
  constructor() {
    this.name = "skcom";
    this.priority = 1;
    this.type = "domestic";
  }

  async isHealthy() {
    try {
      // 從根目錄 hft_service_status.json 讀取即時狀態
      const h = JSON.parse(await fs.readFile(CAPITAL_HFT_STATUS_ROOT, "utf8"));
      // 相容兩種格式：根目錄用 status="running"，舊 UI 用 running=true
      const isRunning = h.status === "running" || h.running === true;
      const isLoggedIn = h.loginStatus === "connected" || h.loginStatus === "logged_in";
      return isRunning && isLoggedIn;
    } catch {
      try {
        const fb = JSON.parse(
          await fs.readFile(
            path.join(CAPITAL_HFT_STATE, "capital_latest_quote_event.json"),
            "utf8",
          ),
        );
        return fb && fb.receivedAt && Date.now() - new Date(fb.receivedAt).getTime() < 600000;
      } catch {
        return false;
      }
    }
  }

  async getQuote(symbol) {
    let data;
    const tryParseQuoteJson = (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        // 處理多物件串接損壞: 取第一個完整 JSON 物件
        const start = raw.indexOf("{");
        if (start < 0) return null;
        let depth = 0;
        for (let i = start; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) {
              try {
                return JSON.parse(raw.slice(start, i + 1));
              } catch {
                return null;
              }
            }
          }
        }
        return null;
      }
    };
    try {
      data = tryParseQuoteJson(
        await fs.readFile(path.join(CAPITAL_HFT, "capital_latest_quote_event.json"), "utf8"),
      );
      if (!data) throw new Error("corrupt json");
    } catch {
      data = tryParseQuoteJson(
        await fs.readFile(path.join(CAPITAL_HFT_STATE, "capital_latest_quote_event.json"), "utf8"),
      );
    }
    const price = parseFloat(data.close) || parseFloat(data.price) || 0;
    const bid = parseFloat(data.bid) || null;
    const ask = parseFloat(data.ask) || null;
    const decimal = parseInt(data.decimal) || 0;
    const divisor = decimal > 0 ? Math.pow(10, decimal) : 1;
    return {
      source: this.name,
      symbol,
      price: price / divisor,
      bid: bid ? bid / divisor : null,
      ask: ask ? ask / divisor : null,
      volume: parseInt(data.qty) || 0,
      time: data.receivedAt || data.time || data.ts,
      stockNo: data.stockNo,
      stockName: data.stockName,
    };
  }

  async getBars(symbol, opts = {}) {
    let fp = path.join(CAPITAL_HFT, "capital_quote_events.jsonl");
    try {
      await fs.access(fp);
    } catch {
      fp = path.join(CAPITAL_HFT_STATE, "capital_quote_events.jsonl");
    }
    const raw = await fs.readFile(fp, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .slice(-(opts.limit || 100));
    return lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

// === OsQuoteSource ===
class OsQuoteSource {
  constructor() {
    this.name = "os_hft";
    this.priority = 2;
    this.type = "overseas";
  }

  async isHealthy() {
    try {
      // 從根目錄 hft_service_status.json 讀取即時狀態
      const h = JSON.parse(await fs.readFile(CAPITAL_HFT_STATUS_ROOT, "utf8"));
      const isRunning = h.status === "running" || h.running === true;
      // 檢查 OS 報價是否有在收到（osQuoteStats 或 subscribedOsStocks）
      const hasOsQuotes =
        h.osQuoteStats?.quoteCount > 0 ||
        (Array.isArray(h.subscribedOsStocks) && h.subscribedOsStocks.length > 0) ||
        h.osQuoteConnected === true;
      return isRunning && hasOsQuotes;
    } catch {
      // Fallback 1: 檢查 quote_status.json
      try {
        const sp = path.join(CAPITAL_HFT_STATE, "quote_status.json");
        const s = JSON.parse(await fs.readFile(sp, "utf8"));
        return s.status === "connected";
      } catch {
        /* quote_status.json 不存在，繼續 fallback */
      }
      // Fallback 2: 檢查最近的 OS log 檔案是否有新資料（10 分鐘內有更新即視為健康）
      try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const logFile = path.join(CAPITAL_HFT, "logs", today + ".log");
        const stat = await fs.stat(logFile);
        return Date.now() - stat.mtimeMs < 600_000; // 10 分鐘內有寫入
      } catch {
        return false;
      }
    }
  }

  async getQuote(symbol) {
    const fp = path.join(CAPITAL_HFT_STATE, "os_latest_quote_event.json");
    const data = JSON.parse(await fs.readFile(fp, "utf8"));
    const dec = parseInt(data.decimal ?? 2, 10);
    const factor = Math.pow(10, dec);
    const rawPrice = parseFloat(data.close || data.price || 0);
    const rawBid = parseFloat(data.bid || 0);
    const rawAsk = parseFloat(data.ask || 0);
    const price = (rawPrice > 0 ? rawPrice : rawBid) / factor;
    return {
      source: this.name,
      symbol,
      price,
      bid: rawBid > 0 ? rawBid / factor : null,
      ask: rawAsk > 0 ? rawAsk / factor : null,
      volume: parseInt(data.qty) || 0,
      time: data.receivedAt || data.time,
      stockNo: data.stockNo,
      stockName: data.stockName,
    };
  }

  async getBars(symbol, opts = {}) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const logDir = path.join(CAPITAL_HFT, "logs");
    try {
      const logFile = path.join(logDir, today + ".log");
      const raw = await fs.readFile(logFile, "utf8");
      const lines = raw
        .split("\n")
        .filter((l) => l.includes("QuoteLONG"))
        .slice(-(opts.limit || 100));
      return lines.map((l) => ({ raw: l, source: this.name }));
    } catch {
      return [];
    }
  }
}

// === YahooSource ===
class YahooSource {
  constructor() {
    this.name = "yahoo";
    this.priority = 5;
    this.type = "delayed";
  }
  async isHealthy() {
    return true;
  }

  async getQuote(symbol) {
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=1m&range=1d";
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000),
      });
      const json = await resp.json();
      const meta =
        (json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta) ||
        {};
      return {
        source: this.name,
        symbol,
        price: meta.regularMarketPrice,
        bid: null,
        ask: null,
        volume: meta.regularMarketVolume,
        time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      };
    } catch (e) {
      return { source: this.name, symbol, error: e.message };
    }
  }

  async getBars(symbol, opts = {}) {
    const interval = opts.interval || "1m";
    const range = opts.range || "1d";
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=" +
      interval +
      "&range=" +
      range;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(10000),
      });
      const json = await resp.json();
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result) return [];
      const ts = result.timestamp || [];
      const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
      return ts
        .map((t, i) => ({
          time: new Date(t * 1000).toISOString(),
          open: q.open && q.open[i],
          high: q.high && q.high[i],
          low: q.low && q.low[i],
          close: q.close && q.close[i],
          volume: q.volume && q.volume[i],
          source: this.name,
        }))
        .filter((b) => b.close != null);
    } catch {
      return [];
    }
  }
}

// === BinanceSource ===
class BinanceSource {
  constructor() {
    this.name = "binance";
    this.priority = 3;
    this.type = "crypto_realtime";
  }
  async isHealthy() {
    return true;
  }

  async getQuote(symbol) {
    const pair = symbol.replace(/[-\/]/g, "").toUpperCase();
    const binSymbol = pair.includes("USDT") ? pair : pair + "USDT";
    try {
      const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + binSymbol, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      return {
        source: this.name,
        symbol,
        price: parseFloat(data.price),
        time: new Date().toISOString(),
      };
    } catch (e) {
      return { source: this.name, symbol, error: e.message };
    }
  }

  async getBars(symbol, opts = {}) {
    const pair = symbol.replace(/[-\/]/g, "").toUpperCase();
    const binSymbol = pair.includes("USDT") ? pair : pair + "USDT";
    const interval = opts.interval || "1m";
    const limit = opts.limit || 100;
    try {
      const resp = await fetch(
        "https://api.binance.com/api/v3/klines?symbol=" +
          binSymbol +
          "&interval=" +
          interval +
          "&limit=" +
          limit,
        { signal: AbortSignal.timeout(10000) },
      );
      const data = await resp.json();
      return data.map((k) => ({
        time: new Date(k[0]).toISOString(),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        source: this.name,
      }));
    } catch {
      return [];
    }
  }
}

// === OkxSource (免費公開 API，無需 API Key) ===
class OkxSource {
  constructor() {
    this.name = "okx";
    this.priority = 3;
    this.type = "crypto_realtime";
  }
  async isHealthy() {
    return true;
  }

  async getQuote(symbol) {
    const pair = symbol.replace(/[-\/]/g, "").toUpperCase();
    const instId = pair.includes("-") ? pair : pair.replace("USDT", "") + "-USDT";
    try {
      const resp = await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + instId, {
        signal: AbortSignal.timeout(5000),
      });
      const json = await resp.json();
      const d = json.data && json.data[0];
      if (!d) return { source: this.name, symbol, error: "no_data" };
      return {
        source: this.name,
        symbol,
        price: parseFloat(d.last),
        bid: parseFloat(d.bidPx),
        ask: parseFloat(d.askPx),
        volume: parseFloat(d.vol24h),
        time: new Date(parseInt(d.ts)).toISOString(),
      };
    } catch (e) {
      return { source: this.name, symbol, error: e.message };
    }
  }

  async getBars(symbol, opts = {}) {
    const pair = symbol.replace(/[-\/]/g, "").toUpperCase();
    const instId = pair.includes("-") ? pair : pair.replace("USDT", "") + "-USDT";
    const bar = opts.interval || "1m";
    const limit = opts.limit || 100;
    try {
      const resp = await fetch(
        "https://www.okx.com/api/v5/market/candles?instId=" +
          instId +
          "&bar=" +
          bar +
          "&limit=" +
          limit,
        { signal: AbortSignal.timeout(10000) },
      );
      const json = await resp.json();
      if (!json.data) return [];
      return json.data
        .map((k) => ({
          time: new Date(parseInt(k[0])).toISOString(),
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
          volume: +k[5],
          source: this.name,
        }))
        .reverse();
    } catch {
      return [];
    }
  }
}

// === TwseSource ===
class TwseSource {
  constructor() {
    this.name = "twse";
    this.priority = 4;
    this.type = "domestic_stock";
  }
  async isHealthy() {
    return true;
  }

  async getQuote(symbol) {
    try {
      const resp = await fetch(
        "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_" + symbol + ".tw",
        { signal: AbortSignal.timeout(5000) },
      );
      const json = await resp.json();
      const info = json.msgArray && json.msgArray[0];
      if (!info) return { source: this.name, symbol, error: "no_data" };
      const bidArr = info.b ? info.b.split("_") : [];
      const askArr = info.a ? info.a.split("_") : [];
      return {
        source: this.name,
        symbol,
        price: parseFloat(info.z) || parseFloat(info.y),
        bid: parseFloat(bidArr[0]) || null,
        ask: parseFloat(askArr[0]) || null,
        volume: parseInt(info.v) || 0,
        time: (info.d || "") + " " + (info.t || ""),
      };
    } catch (e) {
      return { source: this.name, symbol, error: e.message };
    }
  }

  async getBars() {
    return [];
  }
}

// === QuoteRouter ===
export class QuoteRouter {
  constructor(opts = {}) {
    this.sources = [
      new SkcomSource(),
      new OsQuoteSource(),
      new BinanceSource(),
      new OkxSource(),
      new TwseSource(),
      new YahooSource(),
    ];
    this.healthCache = new Map();
    this.healthTtlMs = opts.healthTtlMs || 60000;
    this.stats = { calls: 0, hits: {}, errors: {} };
  }

  async checkHealth(source) {
    const cached = this.healthCache.get(source.name);
    if (cached && Date.now() - cached.checkedAt < this.healthTtlMs) return cached.healthy;
    const healthy = await source.isHealthy().catch(() => false);
    this.healthCache.set(source.name, { healthy, checkedAt: Date.now() });
    return healthy;
  }

  /** 取得統一商品註冊表 */
  async getRegistry() {
    return loadRegistry();
  }

  classifySymbol(symbol) {
    const s = symbol.toUpperCase();
    if (/^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|DOT|AVAX|MATIC|LINK)/.test(s)) return "crypto";
    if (/^(TX|MTX|TE|TF|XIF|GDF|MSF|CPF)/.test(s)) return "domestic_futures";
    if (/^(ES|NQ|YM|RTY|GC|SI|CL|NG|ZB|ZN|6E|6J|6A|6C|6B|HHI|HSI|NK|SGX)/.test(s))
      return "overseas_futures";
    if (/^\d{4}$/.test(s)) return "tw_stock";
    if (/=F$/.test(s) || /^SPY|QQQ|GLD|USO|TLT/.test(s)) return "us_equity";
    return "unknown";
  }

  getSourceOrder(symbolType) {
    switch (symbolType) {
      case "domestic_futures":
        return ["skcom", "yahoo"];
      case "overseas_futures":
        return ["os_hft", "yahoo"];
      case "crypto":
        return ["binance", "okx", "yahoo"];
      case "tw_stock":
        return ["twse", "yahoo"];
      case "us_equity":
        return ["yahoo", "binance"];
      default:
        return ["yahoo", "binance", "skcom", "os_hft"];
    }
  }

  async getQuote(symbol) {
    this.stats.calls++;
    const type = this.classifySymbol(symbol);
    const order = this.getSourceOrder(type);

    for (const srcName of order) {
      const src = this.sources.find((s) => s.name === srcName);
      if (!src) continue;
      const healthy = await this.checkHealth(src);
      if (!healthy) continue;
      try {
        const q = await src.getQuote(symbol);
        if (q && !q.error && q.price) {
          this.stats.hits[srcName] = (this.stats.hits[srcName] || 0) + 1;
          return q;
        }
      } catch (e) {
        this.stats.errors[srcName] = (this.stats.errors[srcName] || 0) + 1;
      }
    }
    return { symbol: symbol, error: "all_sources_failed", type: type, triedSources: order };
  }

  async getBars(symbol, opts = {}) {
    const type = this.classifySymbol(symbol);
    const order = this.getSourceOrder(type);
    for (const srcName of order) {
      const src = this.sources.find((s) => s.name === srcName);
      if (!src) continue;
      try {
        const bars = await src.getBars(symbol, opts);
        if (bars && bars.length > 0) return bars;
      } catch {
        /* next source */
      }
    }
    return [];
  }

  async healthReport() {
    const results = [];
    for (const src of this.sources) {
      const h = await this.checkHealth(src);
      results.push({ name: src.name, type: src.type, priority: src.priority, healthy: h });
    }
    return { sources: results, stats: this.stats, timestamp: new Date().toISOString() };
  }
}

// === CLI ===
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const router = new QuoteRouter();
  const symbol = process.argv[2] || "ES=F";
  if (process.argv.includes("--health")) {
    const hr = await router.healthReport();
    console.log(JSON.stringify(hr, null, 2));
  } else if (process.argv.includes("--bars")) {
    const bars = await router.getBars(symbol, { interval: "1min", limit: 10 });
    console.log(JSON.stringify(bars, null, 2));
  } else {
    const q = await router.getQuote(symbol);
    console.log(JSON.stringify(q, null, 2));
  }
}
