/**
 * RemoteBacktestBridge — connects trader-plugin strategy tools to the
 * remote backtest service (fin-remote-backtest) registered by findoo-backtest-plugin.
 *
 * Replaces the local BacktestEngine for fin_backtest_run and fin_walk_forward_run.
 * Paper trading (fin_strategy_tick + PaperScheduler) still uses onBar() locally.
 */

import type { BacktestProgress } from "./indicator-lib.js";
import { generateStrategyZip } from "./strategy-codegen.js";
import type {
  BacktestConfig,
  BacktestResult,
  StrategyDefinition,
  WalkForwardResult,
} from "./types.js";

/** Minimal interface matching the fin-remote-backtest service shape. */
export interface RemoteBacktestService {
  submit(
    archive: Buffer,
    filename: string,
    params?: Record<string, unknown>,
    wait?: boolean,
  ): Promise<{ task: { task_id: string; status: string }; report?: RemoteReport }>;
  toBacktestResult(
    report: RemoteReport,
    meta: { strategyId: string; initialCapital: number },
  ): BacktestResult;
}

/** Minimal shape of the remote report — matches findoo-backtest-plugin types. */
interface RemoteReport {
  task_id: string;
  performance: Record<string, unknown> | null;
  equity_curve: Array<{ date: string; equity: number }> | null;
  trade_journal: Array<Record<string, unknown>> | null;
}

export interface WalkForwardOptions {
  windows?: number;
  inSamplePct?: number;
  threshold?: number;
}

export class RemoteBacktestBridge {
  constructor(private serviceResolver: () => RemoteBacktestService | undefined) {}

  private getService(): RemoteBacktestService {
    const svc = this.serviceResolver();
    if (!svc) {
      throw new Error(
        "Remote backtest service not available. Ensure findoo-backtest-plugin is loaded.",
      );
    }
    return svc;
  }

  async runBacktest(
    definition: StrategyDefinition,
    config: BacktestConfig,
    onProgress?: (p: BacktestProgress) => void,
  ): Promise<BacktestResult> {
    const service = this.getService();

    onProgress?.({
      strategyId: definition.id,
      currentBar: 0,
      totalBars: 100,
      percentComplete: 0,
      currentEquity: config.capital,
      status: "running",
    });

    // Generate Python strategy ZIP from TS definition
    const { buffer, filename } = await generateStrategyZip(definition, {
      symbol: definition.symbols[0],
    });

    onProgress?.({
      strategyId: definition.id,
      currentBar: 10,
      totalBars: 100,
      percentComplete: 10,
      currentEquity: config.capital,
      status: "running",
    });

    // Submit to remote service and wait for completion
    const result = await service.submit(buffer, filename, {
      engine: "script",
      symbol: definition.symbols[0] ?? "BTC-USD",
      initial_capital: config.capital,
    });

    if (!result.report) {
      throw new Error(
        `Remote backtest completed but returned no report (task: ${result.task.task_id})`,
      );
    }

    onProgress?.({
      strategyId: definition.id,
      currentBar: 100,
      totalBars: 100,
      percentComplete: 100,
      currentEquity: config.capital,
      status: "completed",
    });

    return service.toBacktestResult(result.report, {
      strategyId: definition.id,
      initialCapital: config.capital,
    });
  }

  async runWalkForward(
    definition: StrategyDefinition,
    config: BacktestConfig,
    options?: WalkForwardOptions,
  ): Promise<WalkForwardResult> {
    const numWindows = options?.windows ?? 5;
    const inSamplePct = options?.inSamplePct ?? 0.7;
    const threshold = options?.threshold ?? 0.6;

    const service = this.getService();
    const { buffer, filename } = await generateStrategyZip(definition, {
      symbol: definition.symbols[0],
    });

    // Submit multiple backtests for different date windows
    // Use sequential execution to avoid overwhelming the remote service
    const windows: WalkForwardResult["windows"] = [];
    let totalTrainSharpe = 0;
    let totalTestSharpe = 0;

    // Generate date ranges for walk-forward windows
    // Default: 2 years of data split into N windows
    const now = new Date();
    const totalDays = 730; // ~2 years
    const windowDays = Math.floor(totalDays / numWindows);
    const trainDays = Math.floor(windowDays * inSamplePct);
    const testDays = windowDays - trainDays;

    for (let w = 0; w < numWindows; w++) {
      const windowStartDate = new Date(now);
      windowStartDate.setDate(windowStartDate.getDate() - totalDays + w * windowDays);

      const trainEnd = new Date(windowStartDate);
      trainEnd.setDate(trainEnd.getDate() + trainDays);

      const testEnd = new Date(trainEnd);
      testEnd.setDate(testEnd.getDate() + testDays);

      try {
        // Train period backtest
        const trainResult = await service.submit(buffer, filename, {
          engine: "script",
          symbol: definition.symbols[0] ?? "BTC-USD",
          initial_capital: config.capital,
          start_date: windowStartDate.toISOString().slice(0, 10),
          end_date: trainEnd.toISOString().slice(0, 10),
        });

        // Test period backtest
        const testResult = await service.submit(buffer, filename, {
          engine: "script",
          symbol: definition.symbols[0] ?? "BTC-USD",
          initial_capital: config.capital,
          start_date: trainEnd.toISOString().slice(0, 10),
          end_date: testEnd.toISOString().slice(0, 10),
        });

        const trainBt = trainResult.report
          ? service.toBacktestResult(trainResult.report, {
              strategyId: definition.id,
              initialCapital: config.capital,
            })
          : null;

        const testBt = testResult.report
          ? service.toBacktestResult(testResult.report, {
              strategyId: definition.id,
              initialCapital: config.capital,
            })
          : null;

        const trainSharpe = trainBt?.sharpe ?? 0;
        const testSharpe = testBt?.sharpe ?? 0;

        totalTrainSharpe += trainSharpe;
        totalTestSharpe += testSharpe;

        windows.push({
          trainStart: windowStartDate.getTime(),
          trainEnd: trainEnd.getTime(),
          testStart: trainEnd.getTime(),
          testEnd: testEnd.getTime(),
          trainSharpe,
          testSharpe,
        });
      } catch {
        // Skip failed windows
      }
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
