// NewsFetcher.mjs — 新聞資料來源聚合器
// 支援: NewsAPI.org / Alpha Vantage News / CryptoPanic / ForexFactory 日曆
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Sentiment = require("sentiment");

const CACHE_FILE = "D:\\群益及元大API\\CapitalHftService\\state\\hft_news_cache.json";
const sentiment = new Sentiment();

// ──────────────────────────────────────────────
// 金融新聞特定詞彙擴充（中英文）
// ──────────────────────────────────────────────
const FIN_POSITIVE = [
  "bullish",
  "rally",
  "surge",
  "breakout",
  "upgrade",
  "beat",
  "exceed",
  "strong",
  "record",
  "growth",
  "profit",
  "revenue",
  "acquisition",
  "buyback",
  "dividend",
  "recovery",
  "positive",
  "optimistic",
  "hawkish-positive",
  "dovish-positive",
  "rate cut",
  "stimulus",
  "easing",
  "上漲",
  "多頭",
  "突破",
  "強勁",
  "買超",
  "earnings beat",
  "beat estimates",
  "above expectations",
];
const FIN_NEGATIVE = [
  "bearish",
  "crash",
  "plunge",
  "collapse",
  "downgrade",
  "miss",
  "weak",
  "loss",
  "recession",
  "default",
  "bankruptcy",
  "selloff",
  "liquidation",
  "fear",
  "inflation",
  "risk",
  "bearish",
  "悲觀",
  "下跌",
  "空頭",
  "崩跌",
  "賣超",
  "earnings miss",
  "below expectations",
  "rate hike",
  "tightening",
];

export function scoreSentiment(text) {
  let score = sentiment.analyze(text).score;
  const lower = text.toLowerCase();
  for (const w of FIN_POSITIVE) {
    if (lower.includes(w)) {
      score += 2;
    }
  }
  for (const w of FIN_NEGATIVE) {
    if (lower.includes(w)) {
      score -= 2;
    }
  }
  return score; // 正數=看多，負數=看空
}

// ──────────────────────────────────────────────
// 快取管理
// ──────────────────────────────────────────────
function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    } catch {}
  }
  return { news: [], calendar: [], fetchedAt: null };
}
function saveCache(data) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// ──────────────────────────────────────────────
// 1. NewsAPI.org
// ──────────────────────────────────────────────
export async function fetchNewsApi(
  apiKey,
  keywords = ["futures", "forex", "crypto"],
  pageSize = 20,
) {
  if (!apiKey || apiKey === "YOUR_NEWSAPI_KEY") {
    return [];
  }
  const q = keywords.join(" OR ");
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${apiKey}`;
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await fetch(url, { timeout: 8000 });
    const json = await res.json();
    if (!json.articles) {
      return [];
    }
    return json.articles.map((a) => ({
      source: "newsapi",
      title: a.title ?? "",
      summary: a.description ?? "",
      url: a.url,
      publishedAt: a.publishedAt,
      sentiment: scoreSentiment((a.title ?? "") + " " + (a.description ?? "")),
      keywords: keywords,
    }));
  } catch (e) {
    console.warn("[NewsFetcher] NewsAPI error:", e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// 2. Alpha Vantage News & Sentiment
// ──────────────────────────────────────────────
export async function fetchAlphaVantageNews(apiKey, tickers = "CRYPTO:BTC,FOREX:USD", limit = 20) {
  if (!apiKey || apiKey === "YOUR_AV_KEY") {
    return [];
  }
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${tickers}&limit=${limit}&apikey=${apiKey}`;
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await fetch(url, { timeout: 8000 });
    const json = await res.json();
    if (!json.feed) {
      return [];
    }
    return json.feed.map((a) => ({
      source: "alphavantage",
      title: a.title ?? "",
      summary: a.summary ?? "",
      url: a.url,
      publishedAt: a.time_published,
      // Alpha Vantage 原生情感分數 (-1~1)
      avScore: Number.parseFloat(a.overall_sentiment_score ?? 0),
      avLabel: a.overall_sentiment_label ?? "",
      sentiment: Math.round(Number.parseFloat(a.overall_sentiment_score ?? 0) * 10),
      keywords: [],
    }));
  } catch (e) {
    console.warn("[NewsFetcher] AlphaVantage error:", e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// 3. CryptoPanic (免費，無需 API key 基本版)
// ──────────────────────────────────────────────
export async function fetchCryptoPanic(apiKey = "", currencies = "BTC,ETH", filter = "hot") {
  const auth = apiKey ? `&auth_token=${apiKey}` : "";
  const url = `https://cryptopanic.com/api/v1/posts/?currencies=${currencies}&filter=${filter}&public=true${auth}`;
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await fetch(url, { timeout: 8000 });
    const json = await res.json();
    if (!json.results) {
      return [];
    }
    return json.results.map((a) => ({
      source: "cryptopanic",
      title: a.title ?? "",
      summary: a.title ?? "",
      url: a.url,
      publishedAt: a.published_at,
      // CryptoPanic 有投票欄位
      votes: a.votes ?? {},
      sentiment:
        (a.votes?.positive ?? 0) - (a.votes?.negative ?? 0) + scoreSentiment(a.title ?? ""),
      keywords: currencies.split(","),
    }));
  } catch (e) {
    console.warn("[NewsFetcher] CryptoPanic error:", e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// 4. Financial Modeling Prep — 經濟日曆
// ──────────────────────────────────────────────
export async function fetchFmpCalendar(apiKey, from, to) {
  if (!apiKey || apiKey === "YOUR_FMP_KEY") {
    return [];
  }
  const f = from ?? new Date().toISOString().slice(0, 10);
  const t = to ?? new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${f}&to=${t}&apikey=${apiKey}`;
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await fetch(url, { timeout: 8000 });
    const json = await res.json();
    if (!Array.isArray(json)) {
      return [];
    }
    return json.map((e) => ({
      source: "fmp_calendar",
      event: e.event,
      country: e.country,
      date: e.date,
      impact: e.impact, // 'High' | 'Medium' | 'Low'
      actual: e.actual,
      estimate: e.estimate,
      previous: e.previous,
    }));
  } catch (e) {
    console.warn("[NewsFetcher] FMP Calendar error:", e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// 主聚合器
// ──────────────────────────────────────────────
export class NewsFetcher {
  constructor(config = {}) {
    this.newsApiKey = config.newsApiKey ?? "YOUR_NEWSAPI_KEY";
    this.avApiKey = config.avApiKey ?? "YOUR_AV_KEY";
    this.fmpApiKey = config.fmpApiKey ?? "YOUR_FMP_KEY";
    this.cryptoPanicKey = config.cryptoPanicKey ?? "";
    this.intervalMs = config.intervalMs ?? 5 * 60 * 1000; // 5 分鐘
    this._cache = loadCache();
    this._timer = null;
    this._listeners = []; // callback(articles)
    this._calListeners = []; // callback(events)
  }

  onNews(cb) {
    this._listeners.push(cb);
  }
  onCalendar(cb) {
    this._calListeners.push(cb);
  }

  async fetchAll() {
    const [cp, av, na, cal] = await Promise.allSettled([
      fetchCryptoPanic(this.cryptoPanicKey),
      fetchAlphaVantageNews(this.avApiKey),
      fetchNewsApi(this.newsApiKey),
      fetchFmpCalendar(this.fmpApiKey),
    ]);

    const news = [...(cp.value ?? []), ...(av.value ?? []), ...(na.value ?? [])].toSorted(
      (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
    );

    const calendar = cal.value ?? [];

    this._cache = { news, calendar, fetchedAt: new Date().toISOString() };
    saveCache(this._cache);

    if (news.length) {
      this._listeners.forEach((cb) => cb(news));
    }
    if (calendar.length) {
      this._calListeners.forEach((cb) => cb(calendar));
    }
    return { news, calendar };
  }

  start() {
    void this.fetchAll();
    this._timer = setInterval(() => void this.fetchAll(), this.intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
    }
  }

  // 取最新快取（供策略同步讀取）
  getLatestNews() {
    return this._cache.news ?? [];
  }
  getCalendar() {
    return this._cache.calendar ?? [];
  }
  getFetchedAt() {
    return this._cache.fetchedAt;
  }
}
