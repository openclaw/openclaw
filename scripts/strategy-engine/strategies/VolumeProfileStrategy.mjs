// VolumeProfileStrategy.mjs — Volume Profile / Market Profile 交易策略
// 移植自 TradingView Volume Profile / Sierra Chart Market Profile
// 開源參考: https://github.com/anilknayak/volume_profile
//
// 核心概念：
//   POC  (Point of Control)  — 成交量最大的價格 → 磁吸力強，突破後反轉
//   VAH  (Value Area High)   — 價值區上緣 (70% 成交量範圍的上界)
//   VAL  (Value Area Low)    — 價值區下緣 (70% 成交量範圍的下界)
//   累計 Delta — 主動買盤 - 主動賣盤，正值代表買壓強
//
// 訊號邏輯：
//   價格從 VAL 反彈 + Delta 正   → 買進
//   價格從 VAH 反彈 + Delta 負   → 賣出
//   突破 POC 且成交量放量         → 趨勢進場
//   Delta 背離（價格新高但 Delta 下降）→ 預警反轉
import { BaseStrategy } from "../BaseStrategy.mjs";

function buildVolumeProfile(bars, tickSize = 1) {
  // 用每根 K 棒的 high-low 均分成交量，建構 Volume Profile
  const profile = new Map(); // price_level → { totalVol, buyVol, sellVol }

  for (const bar of bars) {
    if (!bar.volume || bar.volume <= 0) {
      continue;
    }
    const levels = Math.max(1, Math.round((bar.high - bar.low) / tickSize));
    const volPerLevel = bar.volume / levels;

    // 估算主動買賣：收漲 → 偏買；收跌 → 偏賣
    const bullishRatio = bar.close >= bar.open ? 0.6 : 0.4;

    for (let i = 0; i <= levels; i++) {
      const lvl = +(bar.low + i * tickSize).toFixed(4);
      const rounded = Math.round(lvl / tickSize) * tickSize;
      const key = +rounded.toFixed(4);
      if (!profile.has(key)) {
        profile.set(key, { totalVol: 0, buyVol: 0, sellVol: 0 });
      }
      const entry = profile.get(key);
      entry.totalVol += volPerLevel;
      entry.buyVol += volPerLevel * bullishRatio;
      entry.sellVol += volPerLevel * (1 - bullishRatio);
    }
  }
  return profile;
}

function calcPocVahVal(profile) {
  if (profile.size === 0) {
    return { poc: 0, vah: 0, val: 0, totalVol: 0 };
  }
  const sorted = [...profile.entries()].toSorted((a, b) => a[0] - b[0]);
  const totalVol = sorted.reduce((s, [, v]) => s + v.totalVol, 0);

  // POC = 成交量最大格
  let poc = 0,
    pocVol = 0;
  for (const [price, v] of sorted) {
    if (v.totalVol > pocVol) {
      pocVol = v.totalVol;
      poc = price;
    }
  }

  // Value Area = 從 POC 向外擴展直到涵蓋 70% 成交量
  const target = totalVol * 0.7;
  const pocIdx = sorted.findIndex(([p]) => p === poc);
  let lo = pocIdx,
    hi = pocIdx;
  let accumulated = sorted[pocIdx][1].totalVol;

  while (accumulated < target && (lo > 0 || hi < sorted.length - 1)) {
    const addLo = lo > 0 ? sorted[lo - 1][1].totalVol : 0;
    const addHi = hi < sorted.length - 1 ? sorted[hi + 1][1].totalVol : 0;
    if (addHi >= addLo) {
      hi++;
      accumulated += addHi;
    } else {
      lo--;
      accumulated += addLo;
    }
  }

  return {
    poc,
    vah: sorted[hi][0],
    val: sorted[lo][0],
    totalVol,
  };
}

function calcCumulativeDelta(bars) {
  // 累計 Delta = Σ (buyVol - sellVol)
  // 近似：收漲 K 棒估 60% 買 / 40% 賣；收跌 K 棒估 40% 買 / 60% 賣
  let delta = 0;
  const deltas = [];
  for (const bar of bars) {
    const vol = bar.volume ?? 0;
    const bull = bar.close >= bar.open ? 0.6 : 0.4;
    delta += vol * bull - vol * (1 - bull);
    deltas.push(delta);
  }
  return deltas;
}

export class VolumeProfileStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.lookbackBars = this.params.lookbackBars ?? 100; // 計算 Profile 的 K 棒數
    this.tickSize = this.params.tickSize ?? 1; // 價格最小跳動
    this.pocBreakMult = this.params.pocBreakMult ?? 1.5; // 突破 POC 時成交量倍數
    this.vahBounceRsi = this.params.vahBounceRsi ?? 0.3; // 距 VAH/VAL 容差比例
    this.deltaLookback = this.params.deltaLookback ?? 5; // Delta 趨勢確認窗口
    this.rebalanceN = this.params.rebalanceN ?? 20; // 每 N 根重算 Profile
    this.volAvgPeriod = this.params.volAvgPeriod ?? 20; // 成交量均值週期

    this._poc = 0;
    this._vah = 0;
    this._val = 0;
    this._pocVol = 0;
    this._barsSinceRebuild = 999;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const n = this.barCount();
    if (n < this.lookbackBars) {
      return;
    }

    // ── 重算 Volume Profile ───────────────────
    this._barsSinceRebuild++;
    if (this._barsSinceRebuild >= this.rebalanceN) {
      const recent = this._priceHistory.slice(-this.lookbackBars);
      const profile = buildVolumeProfile(recent, this.tickSize);
      const { poc, vah, val } = calcPocVahVal(profile);
      this._poc = poc;
      this._vah = vah;
      this._val = val;
      // 找 POC 格位的成交量
      const pocEntry = profile.get(poc);
      this._pocVol = pocEntry?.totalVol ?? 0;
      this._barsSinceRebuild = 0;
    }

    if (!this._poc) {
      return;
    }

    const price = bar.close;
    const vol = bar.volume ?? 0;
    const closes = this.closes();

    // ── 成交量均值 ────────────────────────────
    const vols = this._priceHistory.slice(-this.volAvgPeriod).map((b) => b.volume ?? 0);
    const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length || 1;

    // ── 累計 Delta 趨勢 ───────────────────────
    const deltas = calcCumulativeDelta(this._priceHistory.slice(-this.deltaLookback));
    const deltaSlope = deltas[deltas.length - 1] - deltas[0]; // 正 → 買壓增加

    // ── 價值區寬度（容差計算基準）────────────
    const vaWidth = this._vah - this._val || this._poc * 0.002;
    const tol = vaWidth * this.vahBounceRsi;

    // ── 訊號 1：VAL 反彈（做多）─────────────
    if (Math.abs(price - this._val) <= tol && deltaSlope > 0 && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `VAL反彈平空`, this.maxQty);
      }
      this.signal(
        "buy",
        `📊 VP做多 VAL=${this._val.toFixed(1)} POC=${this._poc.toFixed(1)} VAH=${this._vah.toFixed(1)} Delta↑${deltaSlope.toFixed(0)}`,
        this.maxQty,
      );
      this._position = 1;
      return;
    }

    // ── 訊號 2：VAH 反彈（做空）─────────────
    if (Math.abs(price - this._vah) <= tol && deltaSlope < 0 && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `VAH反彈平多`, this.maxQty);
      }
      this.signal(
        "sell",
        `📊 VP做空 VAH=${this._vah.toFixed(1)} POC=${this._poc.toFixed(1)} VAL=${this._val.toFixed(1)} Delta↓${deltaSlope.toFixed(0)}`,
        this.maxQty,
      );
      this._position = -1;
      return;
    }

    // ── 訊號 3：POC 放量突破（趨勢方向進場）───
    const prevPrice = closes[closes.length - 2] ?? price;
    const crossAbovePoc = prevPrice <= this._poc && price > this._poc;
    const crossBelowPoc = prevPrice >= this._poc && price < this._poc;

    if (crossAbovePoc && vol > avgVol * this.pocBreakMult && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `POC突破平空`, this.maxQty);
      }
      this.signal(
        "buy",
        `📊 VP多突POC=${this._poc.toFixed(1)} 量${vol.toFixed(0)}>${(avgVol * this.pocBreakMult).toFixed(0)}`,
        this.maxQty,
      );
      this._position = 1;
      return;
    }

    if (crossBelowPoc && vol > avgVol * this.pocBreakMult && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `POC跌破平多`, this.maxQty);
      }
      this.signal(
        "sell",
        `📊 VP空破POC=${this._poc.toFixed(1)} 量${vol.toFixed(0)}>${(avgVol * this.pocBreakMult).toFixed(0)}`,
        this.maxQty,
      );
      this._position = -1;
      return;
    }

    // ── 訊號 4：Delta 背離警示 ─────────────
    // 價格創 lookback 新高但 Delta 下降 → 平多
    const highN = Math.max(...closes.slice(-this.deltaLookback));
    if (price >= highN && deltaSlope < -avgVol * 0.1 && this._position === 1) {
      this.signal("close_long", `📊 VP Delta背離平多 價創高但Delta弱`, this.maxQty);
      this._position = 0;
    }
  }

  /** 取得當前 Profile 關鍵價位 */
  getLevels() {
    return { poc: this._poc, vah: this._vah, val: this._val };
  }
}
