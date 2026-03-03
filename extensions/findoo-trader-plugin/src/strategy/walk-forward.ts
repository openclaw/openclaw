import type { OHLCV } from "../shared/types.js";
import type { BacktestEngine } from "./backtest-engine.js";
import type { BacktestConfig, StrategyDefinition, WalkForwardResult } from "./types.js";

export interface WalkForwardOptions {
  windows?: number; // number of train/test windows (default 5)
  inSamplePct?: number; // fraction of each window for training (default 0.7)
  threshold?: number; // pass if combinedTest / avgTrain >= threshold (default 0.6)
}

/**
 * Walk-Forward validation.
 * Splits data into N windows, runs backtest on train and test segments,
 * and checks if out-of-sample performance is at least threshold * in-sample.
 */
export class WalkForward {
  constructor(private engine: BacktestEngine) {}

  async validate(
    strategy: StrategyDefinition,
    data: OHLCV[],
    config: BacktestConfig,
    options?: WalkForwardOptions,
  ): Promise<WalkForwardResult> {
    const numWindows = options?.windows ?? 5;
    const inSamplePct = options?.inSamplePct ?? 0.7;
    const threshold = options?.threshold ?? 0.6;

    if (data.length < numWindows * 2) {
      return {
        passed: false,
        windows: [],
        combinedTestSharpe: 0,
        avgTrainSharpe: 0,
        ratio: 0,
        threshold,
      };
    }

    // Calculate window size: each window is data.length / numWindows bars
    const windowSize = Math.floor(data.length / numWindows);
    const trainSize = Math.floor(windowSize * inSamplePct);
    const testSize = windowSize - trainSize;

    const windows: WalkForwardResult["windows"] = [];
    let totalTrainSharpe = 0;
    let totalTestSharpe = 0;

    for (let w = 0; w < numWindows; w++) {
      const windowStart = w * windowSize;
      const trainStart = windowStart;
      const trainEnd = windowStart + trainSize;
      const testStart = trainEnd;
      const testEnd = Math.min(windowStart + windowSize, data.length);

      const trainData = data.slice(trainStart, trainEnd);
      const testData = data.slice(testStart, testEnd);

      if (trainData.length < 2 || testData.length < 2) continue;

      const trainResult = await this.engine.run(strategy, trainData, config);
      const testResult = await this.engine.run(strategy, testData, config);

      const trainSharpe = trainResult.sharpe;
      const testSharpe = testResult.sharpe;

      totalTrainSharpe += trainSharpe;
      totalTestSharpe += testSharpe;

      windows.push({
        trainStart: trainData[0]!.timestamp,
        trainEnd: trainData[trainData.length - 1]!.timestamp,
        testStart: testData[0]!.timestamp,
        testEnd: testData[testData.length - 1]!.timestamp,
        trainSharpe,
        testSharpe,
      });
    }

    if (windows.length === 0) {
      return {
        passed: false,
        windows: [],
        combinedTestSharpe: 0,
        avgTrainSharpe: 0,
        ratio: 0,
        threshold,
      };
    }

    const combinedTestSharpe = totalTestSharpe / windows.length;
    const avgTrainSharpe = totalTrainSharpe / windows.length;

    // Handle edge cases for ratio
    let ratio: number;
    if (avgTrainSharpe === 0) {
      ratio = combinedTestSharpe >= 0 ? 1 : 0;
    } else {
      ratio = combinedTestSharpe / avgTrainSharpe;
    }

    const safeCombined = Number.isFinite(combinedTestSharpe) ? combinedTestSharpe : 0;
    const safeRatio = Number.isFinite(ratio) ? ratio : 0;

    return {
      passed: safeRatio >= threshold,
      windows,
      combinedTestSharpe: safeCombined,
      avgTrainSharpe,
      ratio: safeRatio,
      threshold,
    };
  }
}
