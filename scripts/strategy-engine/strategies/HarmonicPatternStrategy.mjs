// HarmonicPatternStrategy.mjs — 諧波形態交易策略
// 移植自 Scott Carney "Harmonic Trading" / TradingView Harmonic Pattern Indicator
// 開源參考: https://github.com/vsmolyakov/fin_ml/tree/master/harmonic
//
// 支援形態（XA-AB-BC-CD Fibonacci 比率驗證）：
//   Gartley    — 最古老諧波：AB=0.618×XA, BC=0.382~0.886×AB, CD=1.272~1.618×BC
//   Butterfly  — AB=0.786×XA, BC=0.382~0.886×AB, CD=1.618~2.618×BC
//   Bat        — AB=0.382~0.5×XA, BC=0.382~0.886×AB, CD=1.618~2.618×BC
//   Crab       — AB=0.382~0.618×XA, BC=0.382~0.886×AB, CD=2.618~3.618×BC
//   ABCD       — AB=BC (等長), CD=AB×1.27~1.618
//
// 訊號邏輯：
//   找到 XABCD 5 個 Pivot 點 → 在 D 點完成時進場
//   Bullish 形態（W 型）→ 買進
//   Bearish 形態（M 型）→ 賣出
import { BaseStrategy } from "../BaseStrategy.mjs";

// ── Fibonacci 比率表 ──────────────────────────────────────────────
const PATTERNS = {
  Gartley: {
    abXa: [0.618, 0.618], // AB/XA
    bcAb: [0.382, 0.886], // BC/AB
    cdBc: [1.272, 1.618], // CD/BC
    xadXa: [0.786, 0.786], // XD/XA (PRZ)
  },
  Butterfly: {
    abXa: [0.786, 0.786],
    bcAb: [0.382, 0.886],
    cdBc: [1.618, 2.618],
    xadXa: [1.272, 1.618],
  },
  Bat: {
    abXa: [0.382, 0.5],
    bcAb: [0.382, 0.886],
    cdBc: [1.618, 2.618],
    xadXa: [0.886, 0.886],
  },
  Crab: {
    abXa: [0.382, 0.618],
    bcAb: [0.382, 0.886],
    cdBc: [2.618, 3.618],
    xadXa: [1.618, 1.618],
  },
  Shark: {
    abXa: [0.446, 0.618],
    bcAb: [1.13, 1.618],
    cdBc: [0.886, 1.13],
    xadXa: [0.886, 1.13],
  },
};

function inRange(val, [lo, hi], tol = 0.06) {
  return val >= lo * (1 - tol) && val <= hi * (1 + tol);
}

/**
 * 驗證 XABCD 是否符合某個諧波形態
 * @param {number} X,A,B,C,D 價格樞紐點
 * @param {boolean} bullish  true=W型(做多), false=M型(做空)
 * @returns {string|null} 形態名稱或 null
 */
function matchPattern(X, A, B, C, D, _bullish) {
  const XA = Math.abs(X - A);
  const AB = Math.abs(A - B);
  const BC = Math.abs(B - C);
  const CD = Math.abs(C - D);

  if (XA < 1e-10) {
    return null;
  }

  for (const [name, rules] of Object.entries(PATTERNS)) {
    const abRat = AB / XA;
    const bcRat = BC / AB || 0;
    const cdRat = CD / BC || 0;
    const xdRat = Math.abs(X - D) / XA;

    if (
      inRange(abRat, rules.abXa) &&
      inRange(bcRat, rules.bcAb) &&
      inRange(cdRat, rules.cdBc) &&
      inRange(xdRat, rules.xadXa)
    ) {
      return name;
    }
  }

  // ABCD 形態（3 點，無 X）
  if (inRange(BC / AB || 0, [0.618, 0.786]) && inRange(CD / BC || 0, [1.272, 1.618])) {
    return "ABCD";
  }

  return null;
}

// ── Pivot 偵測（簡化：ZigZag 取擺動高低）────────────────────────
function findPivots(bars, swingBars = 5) {
  const pivots = [];
  for (let i = swingBars; i < bars.length - swingBars; i++) {
    const window = bars.slice(i - swingBars, i + swingBars + 1);
    const isHigh = bars[i].high === Math.max(...window.map((b) => b.high));
    const isLow = bars[i].low === Math.min(...window.map((b) => b.low));
    if (isHigh) {
      pivots.push({ price: bars[i].high, type: "H", idx: i, time: bars[i].time });
    }
    if (isLow) {
      pivots.push({ price: bars[i].low, type: "L", idx: i, time: bars[i].time });
    }
  }
  return pivots;
}

export class HarmonicPatternStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.swingBars = this.params.swingBars ?? 5; // 擺動高低判定 N 根
    this.minPatterns = this.params.minPatterns ?? 1; // 觸發所需最少匹配
    this.lookback = this.params.lookback ?? 100; // 取最近 N 根找型態
    this.targetRr = this.params.targetRr ?? 1.618; // 目標 R:R 倍數
    this.tolerance = this.params.tolerance ?? 0.06; // Fib 比率容差 ±6%

    this._position = 0;
    this._lastDetected = null;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.lookback) {
      return;
    }

    const bars = this._priceHistory.slice(-this.lookback);
    const pivots = findPivots(bars, this.swingBars);

    if (pivots.length < 4) {
      return;
    }

    // 取最近 5 個不連續方向的 Pivots → X A B C D
    const altPivots = [];
    for (let i = pivots.length - 1; i >= 0 && altPivots.length < 5; i--) {
      const last = altPivots[altPivots.length - 1];
      if (!last || last.type !== pivots[i].type) {
        altPivots.unshift(pivots[i]);
      }
    }

    if (altPivots.length < 5) {
      return;
    }

    const [pX, pA, pB, pC, pD] = altPivots.slice(-5);
    const { price: X } = pX;
    const { price: A } = pA;
    const { price: B } = pB;
    const { price: C } = pC;
    const { price: D } = pD;

    // 判斷方向：X→A 向下 → Bullish (W型)
    const bullish = A < X && C < A && D < B;
    const bearish = A > X && C > A && D > B;

    if (!bullish && !bearish) {
      return;
    }

    const patternName = matchPattern(X, A, B, C, D, bullish);
    if (!patternName) {
      return;
    }

    // 避免重複訊號
    const key = `${patternName}_${pD.idx}`;
    if (this._lastDetected === key) {
      return;
    }
    this._lastDetected = key;

    // 計算 PRZ (Potential Reversal Zone) 和 止損
    const XA = Math.abs(X - A);
    const stopPct = 0.01; // 1% 超過 PRZ 則止損

    if (bullish && this._position !== 1) {
      const stopLoss = D * (1 - stopPct);
      const takeProfit = D + XA * this.targetRr * (A > X ? -1 : 1);
      if (this._position === -1) {
        this.signal("close_short", `${patternName} 平空`, this.maxQty);
      }
      this.signal(
        "buy",
        `🎯 ${patternName} Bullish D=${D.toFixed(1)} TP=${takeProfit.toFixed(1)} SL=${stopLoss.toFixed(1)} X=${X.toFixed(1)}`,
        this.maxQty,
      );
      this._position = 1;
    } else if (bearish && this._position !== -1) {
      const stopLoss = D * (1 + stopPct);
      const takeProfit = D - XA * this.targetRr;
      if (this._position === 1) {
        this.signal("close_long", `${patternName} 平多`, this.maxQty);
      }
      this.signal(
        "sell",
        `🎯 ${patternName} Bearish D=${D.toFixed(1)} TP=${takeProfit.toFixed(1)} SL=${stopLoss.toFixed(1)} X=${X.toFixed(1)}`,
        this.maxQty,
      );
      this._position = -1;
    }
  }
}
