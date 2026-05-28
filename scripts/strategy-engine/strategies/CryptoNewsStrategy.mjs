// CryptoNewsStrategy.mjs — 加密貨幣新聞事件驅動策略
// 來源: CryptoPanic API（免費無需 API Key 基本版）
// 開源參考：freqtrade newshawk / crypto-trading-bot sentiment
//
// 特性：
//   - CryptoPanic 投票分數（👍 - 👎 + AFINN 情感）
//   - 支援 "important" / "hot" 過濾
//   - 重大利多新聞（分數 > 閾值）→ 買
//   - 重大利空新聞（分數 < 閾值）→ 賣
//   - 設有冷卻期（cooldownMins）避免過度交易
import { BaseStrategy } from "../BaseStrategy.mjs";

// 高影響力關鍵字加乘
const BULL_BOOST = [
  "etf approved",
  "listing",
  "partnership",
  "upgrade",
  "bull",
  "all-time high",
  "ath",
  "institutional",
  "accumulate",
  "上市",
  "通過",
  "ETF",
  "牛市",
  "歷史新高",
];
const BEAR_BOOST = [
  "hack",
  "exploit",
  "ban",
  "lawsuit",
  "sec",
  "fraud",
  "crash",
  "liquidation",
  "delisting",
  "bear",
  "rug pull",
  "駭客",
  "禁止",
  "訴訟",
  "崩盤",
  "清算",
];

function boostedScore(article) {
  let score = article.sentiment ?? 0;
  const text = (article.title + " " + (article.summary ?? "")).toLowerCase();
  for (const w of BULL_BOOST) {
    if (text.includes(w)) {
      score += 3;
    }
  }
  for (const w of BEAR_BOOST) {
    if (text.includes(w)) {
      score -= 3;
    }
  }
  return score;
}

export class CryptoNewsStrategy extends BaseStrategy {
  constructor(config, newsFetcher) {
    super(config);
    if (!newsFetcher) {
      throw new Error("CryptoNewsStrategy 需要傳入 NewsFetcher 實例");
    }
    this.fetcher = newsFetcher;
    // 只看包含這些幣種的新聞（空 = 全部）
    this.coins = this.params.coins ?? ["BTC", "bitcoin"];
    this.windowMins = this.params.windowMins ?? 30;
    this.bullishThreshold = this.params.bullishThreshold ?? 8;
    this.bearishThreshold = this.params.bearishThreshold ?? -8;
    this.minArticles = this.params.minArticles ?? 1;
    this.cooldownMins = this.params.cooldownMins ?? 60;
    this._lastSignalTime = 0;
    this._position = 0;
  }

  _getFilteredScore() {
    const news = this.fetcher.getLatestNews();
    const cutoff = new Date(Date.now() - this.windowMins * 60000);

    const relevant = news.filter((a) => {
      if (a.source !== "cryptopanic" && a.source !== "alphavantage" && a.source !== "newsapi") {
        return false;
      }
      if (new Date(a.publishedAt) < cutoff) {
        return false;
      }
      if (this.coins.length === 0) {
        return true;
      }
      const text = (a.title + " " + (a.summary ?? "")).toLowerCase();
      return this.coins.some((c) => text.includes(c.toLowerCase()));
    });

    if (relevant.length < this.minArticles) {
      return { score: 0, count: 0, headlines: [] };
    }

    const score = relevant.reduce((s, a) => s + boostedScore(a), 0);
    const headlines = relevant.slice(0, 3).map((a) => a.title);
    return { score, count: relevant.length, headlines };
  }

  onBar(bar) {
    this.addBar(bar);

    // 冷卻期檢查
    if (Date.now() - this._lastSignalTime < this.cooldownMins * 60000) {
      return;
    }

    const { score, count, headlines } = this._getFilteredScore();
    if (count < this.minArticles) {
      return;
    }

    if (score >= this.bullishThreshold && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `幣圈新聞翻多 score=${score}`, this.maxQty);
      }
      this.signal(
        "buy",
        `📰 幣圈利多 score=${score}(${count}篇) "${headlines[0] ?? ""}"`,
        this.maxQty,
      );
      this._position = 1;
      this._lastSignalTime = Date.now();
    } else if (score <= this.bearishThreshold && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `幣圈新聞翻空 score=${score}`, this.maxQty);
      }
      this.signal(
        "sell",
        `📰 幣圈利空 score=${score}(${count}篇) "${headlines[0] ?? ""}"`,
        this.maxQty,
      );
      this._position = -1;
      this._lastSignalTime = Date.now();
    }
  }
}
