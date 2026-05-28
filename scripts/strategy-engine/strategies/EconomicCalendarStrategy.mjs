// EconomicCalendarStrategy.mjs — 經濟日曆事件交易策略
// 移植自 MT4 News Trading EA (NFP/CPI/FOMC EA)
// 開源參考：https://www.mql5.com/en/code/12464
//
// 邏輯：
//   Pre-event:  重大事件前 preMinutes 分鐘 → 平倉所有部位（避險）
//   Post-event: 事件後 postMinutes 分鐘 → 依 actual vs estimate 決定方向
//     actual > estimate (利多) → 買
//     actual < estimate (利空) → 賣
//
// 高影響力事件：NFP、CPI、FOMC、GDP、PMI、央行利率決議
import { BaseStrategy } from "../BaseStrategy.mjs";

const HIGH_IMPACT_KEYWORDS = [
  "Non-Farm",
  "NFP",
  "CPI",
  "Core CPI",
  "PCE",
  "FOMC",
  "Fed Rate",
  "Interest Rate",
  "GDP",
  "PMI",
  "Manufacturing PMI",
  "ISM",
  "Initial Jobless",
  "Retail Sales",
  "Trade Balance",
  "Central Bank",
  "非農",
  "消費者物價",
  "聯準會",
  "利率決議",
  "GDP",
  "製造業PMI",
];

function isHighImpact(event) {
  if (event.impact === "High") {
    return true;
  }
  const text = (event.event ?? "").toLowerCase();
  return HIGH_IMPACT_KEYWORDS.some((k) => text.toLowerCase().includes(k.toLowerCase()));
}

function getEventDirection(event) {
  const actual = Number.parseFloat(event.actual);
  const estimate = Number.parseFloat(event.estimate);
  if (Number.isNaN(actual) || Number.isNaN(estimate)) {
    return 0;
  }
  return actual > estimate ? 1 : actual < estimate ? -1 : 0;
}

export class EconomicCalendarStrategy extends BaseStrategy {
  constructor(config, newsFetcher) {
    super(config);
    if (!newsFetcher) {
      throw new Error("EconomicCalendarStrategy 需要傳入 NewsFetcher 實例");
    }
    this.fetcher = newsFetcher;
    // 事件前幾分鐘進入避險模式（平倉）
    this.preMinutes = this.params.preMinutes ?? 5;
    // 事件後幾分鐘進場
    this.postMinutes = this.params.postMinutes ?? 2;
    // 持倉時間（分鐘）
    this.holdMins = this.params.holdMins ?? 15;
    // 只交易哪個國家的事件（空 = 全部）
    this.countries = this.params.countries ?? ["US", "USD"];
    this._position = 0;
    this._holdUntil = null;
    this._preEvent = null; // 即將到來的高影響力事件
  }

  _getUpcomingEvents(nowMs) {
    const cal = this.fetcher.getCalendar();
    return cal
      .filter((e) => {
        if (!isHighImpact(e)) {
          return false;
        }
        if (this.countries.length && !this.countries.includes(e.country)) {
          return false;
        }
        const eventMs = new Date(e.date).getTime();
        const diffMin = (eventMs - nowMs) / 60000;
        return diffMin >= -this.postMinutes && diffMin <= 60; // 最近 1 小時內的事件
      })
      .toSorted((a, b) => new Date(a.date) - new Date(b.date));
  }

  onBar(bar) {
    this.addBar(bar);
    const nowMs = Date.now();
    const upcoming = this._getUpcomingEvents(nowMs);

    // 持倉到期 → 平倉
    if (this._holdUntil && nowMs >= this._holdUntil) {
      if (this._position === 1) {
        this.signal("close_long", "新聞持倉到期平倉", this.maxQty);
      }
      if (this._position === -1) {
        this.signal("close_short", "新聞持倉到期平倉", this.maxQty);
      }
      this._position = 0;
      this._holdUntil = null;
    }

    if (!upcoming.length) {
      return;
    }
    const next = upcoming[0];
    const eventMs = new Date(next.date).getTime();
    const diffMin = (eventMs - nowMs) / 60000;

    // 事件前 preMinutes 分鐘 → 避險平倉
    if (diffMin > 0 && diffMin <= this.preMinutes && this._position !== 0) {
      if (this._position === 1) {
        this.signal("close_long", `事件前避險: ${next.event}`, this.maxQty);
      }
      if (this._position === -1) {
        this.signal("close_short", `事件前避險: ${next.event}`, this.maxQty);
      }
      this._position = 0;
      console.log(
        `[EconCalendar] ⚠ 事件前避險: ${next.event} @ ${next.date} impact=${next.impact}`,
      );
    }

    // 事件後 postMinutes 分鐘內 → 依 actual vs estimate 進場
    if (diffMin <= 0 && diffMin >= -this.postMinutes) {
      const dir = getEventDirection(next);
      if (dir !== 0 && this._position === 0) {
        const label = `${next.event} 實際=${next.actual} 預期=${next.estimate}`;
        this._holdUntil = nowMs + this.holdMins * 60000;
        if (dir === 1) {
          this.signal("buy", `📰 經濟日曆利多: ${label}`, this.maxQty);
          this._position = 1;
        } else {
          this.signal("sell", `📰 經濟日曆利空: ${label}`, this.maxQty);
          this._position = -1;
        }
        console.log(`[EconCalendar] 📰 事件進場: ${label} dir=${dir > 0 ? "多" : "空"}`);
      }
    }
  }
}
