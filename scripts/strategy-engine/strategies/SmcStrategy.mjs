// SmcStrategy.mjs — Smart Money Concepts (SMC) 智慧資金概念策略
// 移植自 LuxAlgo SMC Indicator / The Art of Trading SMC
// 開源參考: https://github.com/jmoz/lumibot_smc  |  https://github.com/Zedfrzlb/SMC-Indicator
//
// 核心概念：
//   Order Block (OB)  — 機構大量買賣前最後一根反向K棒（供需區）
//   Fair Value Gap (FVG) — 三根K棒中第1根高和第3根低之間的空隙（未成交缺口）
//   Break of Structure (BOS) — 前一個高點/低點被突破，確認趨勢結構
//   Change of Character (ChoCH) — 結構反轉訊號（趨勢改變）
//   Liquidity Sweep — 掃流動性（短暫突破前高/前低後快速反轉）
//   Premium / Discount — POI (Point of Interest) 位於溢價區或折扣區
//
// 訊號邏輯：
//   BOS 向上 + 回測 Bullish OB + FVG 支撐   → 做多
//   BOS 向下 + 回測 Bearish OB + FVG 壓力   → 做空
//   Liquidity Sweep 掃前高後反轉             → 反向入場
import { BaseStrategy } from "../BaseStrategy.mjs";

// ── 工具函式 ──────────────────────────────────────────────────────

function detectBos(bars, bosLookback) {
  // 找最近 bosLookback 根的結構高低
  // 返回: { bullBos: bool, bearBos: bool, structureHigh, structureLow }
  if (bars.length < bosLookback + 2) {
    return null;
  }

  const recent = bars.slice(-bosLookback - 2);
  const prev = recent.slice(0, -2);
  const last = bars[bars.length - 1];
  const prev2 = bars[bars.length - 2];

  const structureHigh = Math.max(...prev.map((b) => b.high));
  const structureLow = Math.min(...prev.map((b) => b.low));

  // BOS: 本根收盤突破結構高/低
  const bullBos = prev2.close <= structureHigh && last.close > structureHigh;
  const bearBos = prev2.close >= structureLow && last.close < structureLow;

  return { bullBos, bearBos, structureHigh, structureLow };
}

function detectOrderBlocks(bars, obLookback) {
  // Bullish OB: BOS 之前的最後一根陰線（下跌K棒）
  // Bearish OB: BOS 之前的最後一根陽線（上漲K棒）
  const bullishOBs = [];
  const bearishOBs = [];

  for (let i = obLookback; i < bars.length - 1; i++) {
    const bar = bars[i];
    const nextBar = bars[i + 1];

    // Bullish OB: 陰線後接一根大漲（勁揚）
    if (bar.close < bar.open && nextBar.close > nextBar.open && nextBar.close > bar.high * 1.002) {
      bullishOBs.push({ high: bar.high, low: bar.low, mid: (bar.high + bar.low) / 2, idx: i });
    }

    // Bearish OB: 陽線後接一根大跌（勁跌）
    if (bar.close > bar.open && nextBar.close < nextBar.open && nextBar.close < bar.low * 0.998) {
      bearishOBs.push({ high: bar.high, low: bar.low, mid: (bar.high + bar.low) / 2, idx: i });
    }
  }

  return { bullishOBs, bearishOBs };
}

function detectFvg(bars) {
  // Fair Value Gap (FVG): 三根K棒組合
  // Bullish FVG: bar[i-2].high < bar[i].low  (中間有空隙，上漲缺口)
  // Bearish FVG: bar[i-2].low  > bar[i].high (中間有空隙，下跌缺口)
  const bullFvgs = [];
  const bearFvgs = [];

  for (let i = 2; i < bars.length; i++) {
    const b0 = bars[i - 2];
    const b2 = bars[i];

    if (b0.high < b2.low) {
      bullFvgs.push({ top: b2.low, bottom: b0.high, mid: (b2.low + b0.high) / 2, idx: i });
    }
    if (b0.low > b2.high) {
      bearFvgs.push({ top: b0.low, bottom: b2.high, mid: (b0.low + b2.high) / 2, idx: i });
    }
  }

  return { bullFvgs, bearFvgs };
}

function detectLiquiditySweep(bars, swLookback) {
  // 流動性掃蕩：本根 wick 突破前 N 根高/低，但收盤拉回
  if (bars.length < swLookback + 1) {
    return { bullSweep: false, bearSweep: false };
  }

  const prev = bars.slice(-swLookback - 1, -1);
  const last = bars[bars.length - 1];

  const prevHigh = Math.max(...prev.map((b) => b.high));
  const prevLow = Math.min(...prev.map((b) => b.low));

  // Bear Sweep → 看漲：突破前高但收回前高以下（掃空停損）
  const bearSweep = last.high > prevHigh && last.close < prevHigh;
  // Bull Sweep → 看跌：跌破前低但收回前低以上（掃多停損）
  const bullSweep = last.low < prevLow && last.close > prevLow;

  return { bullSweep, bearSweep, prevHigh, prevLow };
}

function isPremium(price, structureHigh, structureLow) {
  const mid = (structureHigh + structureLow) / 2;
  return price > mid; // 溢價區 → 尋找賣點
}

export class SmcStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.bosLookback = this.params.bosLookback ?? 20; // BOS 結構高低回望
    this.obLookback = this.params.obLookback ?? 30; // OB 搜尋範圍
    this.fvgLookback = this.params.fvgLookback ?? 10; // 最近 N 根 FVG
    this.swLookback = this.params.swLookback ?? 15; // Liquidity Sweep 回望
    this.retestTol = this.params.retestTol ?? 0.003; // OB 回測容差 0.3%

    this._position = 0;
    this._lastBos = null;
    this._activeLong = null; // 當前追蹤的多頭 OB
    this._activeShort = null; // 當前追蹤的空頭 OB
  }

  onBar(bar) {
    this.addBar(bar);
    const minBars = Math.max(this.bosLookback, this.obLookback) + 5;
    if (this.barCount() < minBars) {
      return;
    }

    const bars = this._priceHistory;
    const price = bar.close;

    // ── 偵測結構 ────────────────────────────
    const bos = detectBos(bars, this.bosLookback);
    if (!bos) {
      return;
    }

    // ── 偵測 Order Blocks ────────────────────
    const { bullishOBs, bearishOBs } = detectOrderBlocks(
      bars.slice(-this.obLookback),
      this.obLookback,
    );

    // ── 偵測 FVG ─────────────────────────────
    const { bullFvgs, bearFvgs } = detectFvg(bars.slice(-this.fvgLookback - 2));

    // ── 偵測 Liquidity Sweep ─────────────────
    const sweep = detectLiquiditySweep(bars, this.swLookback);

    // ── 多頭進場條件 ─────────────────────────
    //   BOS 向上  OR  掃低流動性後反彈
    //   且價格在折扣區（低於中樞）
    //   且回測到 Bullish OB 或 Bullish FVG
    const inDiscount = !isPremium(price, bos.structureHigh, bos.structureLow);

    if ((bos.bullBos || sweep.bullSweep) && inDiscount && this._position !== 1) {
      // 找最近未填 Bullish OB
      const nearOB = bullishOBs
        .slice()
        .toReversed()
        .find(
          (ob) => price >= ob.low * (1 - this.retestTol) && price <= ob.high * (1 + this.retestTol),
        );
      // 找最近 Bullish FVG
      const nearFvg = bullFvgs
        .slice()
        .toReversed()
        .find((fvg) => price >= fvg.bottom && price <= fvg.top);

      if (nearOB || nearFvg) {
        const reason = nearOB
          ? `📈 SMC多: ${bos.bullBos ? "BOS↑" : "SweepLow"}+OB[${nearOB.low.toFixed(1)}-${nearOB.high.toFixed(1)}]`
          : `📈 SMC多: ${bos.bullBos ? "BOS↑" : "SweepLow"}+FVG[${nearFvg.bottom.toFixed(1)}-${nearFvg.top.toFixed(1)}]`;
        if (this._position === -1) {
          this.signal("close_short", "SMC平空", this.maxQty);
        }
        this.signal("buy", reason, this.maxQty);
        this._position = 1;
        this._activeLong = nearOB ?? { low: nearFvg.bottom, high: nearFvg.top };
        return;
      }
    }

    // ── 空頭進場條件 ─────────────────────────
    //   BOS 向下  OR  掃高流動性後回落
    //   且價格在溢價區（高於中樞）
    //   且回測到 Bearish OB 或 Bearish FVG
    const inPremium = isPremium(price, bos.structureHigh, bos.structureLow);

    if ((bos.bearBos || sweep.bearSweep) && inPremium && this._position !== -1) {
      const nearOB = bearishOBs
        .slice()
        .toReversed()
        .find(
          (ob) => price >= ob.low * (1 - this.retestTol) && price <= ob.high * (1 + this.retestTol),
        );
      const nearFvg = bearFvgs
        .slice()
        .toReversed()
        .find((fvg) => price >= fvg.bottom && price <= fvg.top);

      if (nearOB || nearFvg) {
        const reason = nearOB
          ? `📉 SMC空: ${bos.bearBos ? "BOS↓" : "SweepHigh"}+OB[${nearOB.low.toFixed(1)}-${nearOB.high.toFixed(1)}]`
          : `📉 SMC空: ${bos.bearBos ? "BOS↓" : "SweepHigh"}+FVG[${nearFvg.bottom.toFixed(1)}-${nearFvg.top.toFixed(1)}]`;
        if (this._position === 1) {
          this.signal("close_long", "SMC平多", this.maxQty);
        }
        this.signal("sell", reason, this.maxQty);
        this._position = -1;
        this._activeShort = nearOB ?? { low: nearFvg.bottom, high: nearFvg.top };
        return;
      }
    }

    // ── 停損：突破 OB 結構 ───────────────────
    if (this._position === 1 && this._activeLong) {
      if (price < this._activeLong.low * (1 - this.retestTol * 3)) {
        this.signal(
          "close_long",
          `SMC多停損 跌破OB ${this._activeLong.low.toFixed(1)}`,
          this.maxQty,
        );
        this._position = 0;
        this._activeLong = null;
      }
    }
    if (this._position === -1 && this._activeShort) {
      if (price > this._activeShort.high * (1 + this.retestTol * 3)) {
        this.signal(
          "close_short",
          `SMC空停損 突破OB ${this._activeShort.high.toFixed(1)}`,
          this.maxQty,
        );
        this._position = 0;
        this._activeShort = null;
      }
    }
  }

  /** 取得最新 SMC 結構資訊（除錯用） */
  getStructure() {
    const bars = this._priceHistory;
    if (bars.length < this.bosLookback) {
      return null;
    }
    return detectBos(bars, this.bosLookback);
  }
}
