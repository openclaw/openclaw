/**
 * SimonsSignalCombinerStrategy.mjs — 西蒙斯多信號集成策略
 *
 * 靈感：Renaissance 使用數千個弱信號集成為強預測
 * 原理：
 *   - 同時計算 5 個獨立弱信號
 *   - 用加權投票決定方向（各信號歷史勝率加權）
 *   - Kelly criterion 決定是否出手
 *   - 只有多數信號一致且信心足夠時才交易
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class SimonsSignalCombinerStrategy extends EaBaseStrategy {
  constructor(config) {
    super({
      ...config,
      params: {
        fastPeriod: 8,
        slowPeriod: 21,
        // 信號參數
        rsiPeriod: 14,
        rsiOverbought: 72,
        rsiOversold: 28,
        macdFast: 8,
        macdSlow: 17,
        macdSignal: 9,
        bbPeriod: 20,
        bbStd: 2.0,
        momentumPeriod: 10,
        volumeAvgPeriod: 20,
        // 集成
        minSignals: 3, // 至少 3/5 信號一致
        kellyThreshold: 0.15, // Kelly fraction > 15% 才出手
        // 風控
        maxHoldTicks: 350,
        cooldownMs: 15_000,
        minTicks: 50,
        ...config.params,
      },
    });
    this._holdTicks = 0;
    this._signalRecord = { wins: [0, 0, 0, 0, 0], total: [0, 0, 0, 0, 0] };
  }

  eaTick(tick, _indicators) {
    const p = this.params;
    const prices = this._tickHistory.map((t) => t.price);
    const n = prices.length;
    if (n < Math.max(p.bbPeriod, p.macdSlow, p.rsiPeriod) + 10) {
      return null;
    }

    // ── 1. 計算 5 個獨立信號 ──
    const signals = [
      this._signalRsi(prices, p),
      this._signalMacd(prices, p),
      this._signalBollinger(prices, tick.price, p),
      this._signalMomentum(prices, p),
      this._signalVolumePrice(tick, p),
    ];

    // ── 2. 加權投票 ──
    let bullVotes = 0,
      bearVotes = 0,
      totalWeight = 0;
    for (let i = 0; i < signals.length; i++) {
      const winRate =
        this._signalRecord.total[i] > 10
          ? this._signalRecord.wins[i] / this._signalRecord.total[i]
          : 0.5;
      const weight = Math.max(0.2, winRate);
      totalWeight += weight;
      if (signals[i] > 0) {
        bullVotes += weight;
      } else if (signals[i] < 0) {
        bearVotes += weight;
      }
    }

    const bullRatio = totalWeight > 0 ? bullVotes / totalWeight : 0;
    const bearRatio = totalWeight > 0 ? bearVotes / totalWeight : 0;
    const consensus = Math.max(bullRatio, bearRatio);
    const direction = bullRatio > bearRatio ? 1 : -1;
    const activeSignals = signals.filter((s) => s !== 0).length;

    // ── 3. Kelly criterion 粗估 ──
    const estWinProb = consensus;
    const estPayoff = 1.5; // 假設 1.5:1 盈虧比
    const kelly = estWinProb - (1 - estWinProb) / estPayoff;

    // ── 4. 持倉計數 ──
    if (this._position !== 0) {
      this._holdTicks++;
    } else {
      this._holdTicks = 0;
    }

    // ── 5. 進場 ──
    if (this._position === 0 && activeSignals >= p.minSignals && kelly > p.kellyThreshold) {
      if (direction > 0) {
        return {
          action: "buy",
          reason: `Combine多 votes=${bullRatio.toFixed(2)} kelly=${kelly.toFixed(2)} sigs=${activeSignals}`,
        };
      }
      return {
        action: "sell",
        reason: `Combine空 votes=${bearRatio.toFixed(2)} kelly=${kelly.toFixed(2)} sigs=${activeSignals}`,
      };
    }

    // ── 6. 出場 ──
    if (this._position !== 0) {
      // 信號反轉
      if ((this._position > 0 && bearRatio > 0.7) || (this._position < 0 && bullRatio > 0.7)) {
        return { action: "close", reason: `Combine反轉平 ratio=${consensus.toFixed(2)}` };
      }
      if (this._holdTicks > p.maxHoldTicks) {
        return { action: "close", reason: `Combine超時 hold=${this._holdTicks}` };
      }
    }

    return null;
  }

  // ── 弱信號生成器 ──

  _signalRsi(prices, p) {
    const rsi = this._rsi(prices, p.rsiPeriod);
    if (rsi === null) {
      return 0;
    }
    if (rsi < p.rsiOversold) {
      return 1;
    }
    if (rsi > p.rsiOverbought) {
      return -1;
    }
    return 0;
  }

  _signalMacd(prices, p) {
    const macd = this._macd(prices, p.macdFast, p.macdSlow, p.macdSignal);
    if (!macd) {
      return 0;
    }
    if (macd.histogram > 0 && macd.macd > 0) {
      return 1;
    }
    if (macd.histogram < 0 && macd.macd < 0) {
      return -1;
    }
    return 0;
  }

  _signalBollinger(prices, currentPrice, p) {
    const bb = this._bollingerBands(prices, p.bbPeriod, p.bbStd);
    if (!bb) {
      return 0;
    }
    if (currentPrice < bb.lower) {
      return 1;
    }
    if (currentPrice > bb.upper) {
      return -1;
    }
    return 0;
  }

  _signalMomentum(prices, p) {
    const n = prices.length;
    if (n < p.momentumPeriod + 1) {
      return 0;
    }
    const mom =
      (prices[n - 1] - prices[n - 1 - p.momentumPeriod]) / prices[n - 1 - p.momentumPeriod];
    if (mom > 0.002) {
      return 1;
    }
    if (mom < -0.002) {
      return -1;
    }
    return 0;
  }

  _signalVolumePrice(tick, p) {
    const volumes = this._tickHistory.map((t) => t.volume);
    const n = volumes.length;
    if (n < p.volumeAvgPeriod + 1) {
      return 0;
    }
    const avgVol = volumes.slice(-p.volumeAvgPeriod).reduce((a, b) => a + b, 0) / p.volumeAvgPeriod;
    if (avgVol === 0) {
      return 0;
    }
    const volRatio = tick.volume / avgVol;
    const prices = this._tickHistory.map((t) => t.price);
    const priceChg = (prices[n - 1] - prices[n - 2]) / prices[n - 2];
    // 放量上漲=多，放量下跌=空
    if (volRatio > 1.5 && priceChg > 0) {
      return 1;
    }
    if (volRatio > 1.5 && priceChg < 0) {
      return -1;
    }
    return 0;
  }
}

export default SimonsSignalCombinerStrategy;
