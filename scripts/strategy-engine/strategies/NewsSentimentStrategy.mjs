// NewsSentimentStrategy.mjs — 新聞情感分析交易策略
// 邏輯：每根 K 棒掃描最新新聞，加總最近 N 分鐘內的情感分數
//       分數 > bullishThreshold → 買進
//       分數 < bearishThreshold → 賣出
// 開源參考：freqtrade newshawk strategy / crypto-trading-bot sentiment
import { BaseStrategy } from "../BaseStrategy.mjs";

export class NewsSentimentStrategy extends BaseStrategy {
  constructor(config, newsFetcher) {
    super(config);
    if (!newsFetcher) {
      throw new Error("NewsSentimentStrategy 需要傳入 NewsFetcher 實例");
    }
    this.fetcher = newsFetcher;
    // 關鍵字過濾（只計算與此商品相關的新聞）
    this.keywords = this.params.keywords ?? [];
    // 統計最近幾分鐘的新聞
    this.windowMins = this.params.windowMins ?? 60;
    // 情感分數門檻
    this.bullishThreshold = this.params.bullishThreshold ?? 5;
    this.bearishThreshold = this.params.bearishThreshold ?? -5;
    // 新聞數量門檻（至少 N 篇才交易）
    this.minArticles = this.params.minArticles ?? 2;
    this._position = 0;
  }

  _getRecentScore() {
    const news = this.fetcher.getLatestNews();
    const cutoff = new Date(Date.now() - this.windowMins * 60000);
    const recent = news.filter((a) => {
      if (new Date(a.publishedAt) < cutoff) {
        return false;
      }
      if (this.keywords.length === 0) {
        return true;
      }
      const text = (a.title + " " + a.summary).toLowerCase();
      return this.keywords.some((k) => text.includes(k.toLowerCase()));
    });
    if (recent.length < this.minArticles) {
      return { score: 0, count: recent.length };
    }
    const score = recent.reduce((s, a) => s + (a.sentiment ?? 0), 0);
    return { score, count: recent.length };
  }

  onBar(bar) {
    this.addBar(bar);
    const { score, count } = this._getRecentScore();
    if (count < this.minArticles) {
      return;
    }

    if (score >= this.bullishThreshold && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `新聞情感翻多 score=${score}`, this.maxQty);
      }
      this.signal("buy", `新聞情感看多 score=${score} (${count}篇)`, this.maxQty);
      this._position = 1;
    } else if (score <= this.bearishThreshold && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `新聞情感翻空 score=${score}`, this.maxQty);
      }
      this.signal("sell", `新聞情感看空 score=${score} (${count}篇)`, this.maxQty);
      this._position = -1;
    }
  }
}
