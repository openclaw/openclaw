import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { BacktestEngine, buildIndicatorLib } from "./src/backtest-engine.js";
import { createBollingerBands } from "./src/builtin-strategies/bollinger-bands.js";
import { buildCustomStrategy } from "./src/builtin-strategies/custom-rule-engine.js";
import { createMacdDivergence } from "./src/builtin-strategies/macd-divergence.js";
import { createMultiTimeframeConfluence } from "./src/builtin-strategies/multi-timeframe-confluence.js";
import { createRegimeAdaptive } from "./src/builtin-strategies/regime-adaptive.js";
import { createRiskParityTripleScreen } from "./src/builtin-strategies/risk-parity-triple-screen.js";
import { createRsiMeanReversion } from "./src/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "./src/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "./src/builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "./src/builtin-strategies/volatility-mean-reversion.js";
import { StrategyRegistry } from "./src/strategy-registry.js";
import type { BacktestConfig, StrategyContext, StrategyDefinition } from "./src/types.js";

type OhlcvBar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const plugin = {
  id: "fin-strategy-engine",
  name: "Strategy Engine",
  description: "Strategy lifecycle: indicators, backtest, walk-forward, evolution",
  kind: "financial" as const,
  register(api: OpenClawPluginApi) {
    const registryPath = api.resolvePath("state/fin-strategies.json");
    const registry = new StrategyRegistry(registryPath);
    const engine = new BacktestEngine();

    // Register services
    api.registerService({
      id: "fin-strategy-registry",
      start: () => {},
      instance: registry,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-backtest-engine",
      start: () => {},
      instance: engine,
    } as Parameters<typeof api.registerService>[0]);

    // --- fin_strategy_create ---
    api.registerTool(
      {
        name: "fin_strategy_create",
        label: "Create Strategy",
        description: "Create a new trading strategy from a built-in template or custom definition",
        parameters: Type.Object({
          name: Type.String({ description: "Strategy display name" }),
          type: Type.Unsafe<
            | "sma-crossover"
            | "rsi-mean-reversion"
            | "bollinger-bands"
            | "macd-divergence"
            | "trend-following-momentum"
            | "volatility-mean-reversion"
            | "regime-adaptive"
            | "multi-timeframe-confluence"
            | "risk-parity-triple-screen"
            | "custom"
          >({
            type: "string",
            enum: [
              "sma-crossover",
              "rsi-mean-reversion",
              "bollinger-bands",
              "macd-divergence",
              "trend-following-momentum",
              "volatility-mean-reversion",
              "regime-adaptive",
              "multi-timeframe-confluence",
              "risk-parity-triple-screen",
              "custom",
            ],
            description: "Strategy template type",
          }),
          parameters: Type.Optional(
            Type.Object(
              {},
              {
                additionalProperties: true,
                description: "Strategy parameters (e.g. fastPeriod, slowPeriod)",
              },
            ),
          ),
          symbols: Type.Optional(
            Type.Array(Type.String(), { description: "Trading pair symbols (e.g. BTC/USDT)" }),
          ),
          timeframes: Type.Optional(
            Type.Array(Type.String(), { description: "Timeframes (e.g. 1d, 4h)" }),
          ),
          rules: Type.Optional(
            Type.Object(
              {
                buy: Type.String({
                  description: "Buy rule expression (e.g. 'rsi < 30 AND close > sma')",
                }),
                sell: Type.String({
                  description: "Sell rule expression (e.g. 'rsi > 70 OR close < sma')",
                }),
              },
              { description: "Custom strategy rules (required when type=custom)" },
            ),
          ),
          customParams: Type.Optional(
            Type.Object(
              {},
              {
                additionalProperties: true,
                description: "Custom strategy parameters (e.g. rsiPeriod, smaPeriod)",
              },
            ),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const name = params.name as string;
            const type = params.type as string;
            const stratParams = (params.parameters ?? {}) as Record<string, number>;
            const symbols = (params.symbols as string[] | undefined) ?? ["BTC/USDT"];
            const timeframes = (params.timeframes as string[] | undefined) ?? ["1d"];

            let definition: StrategyDefinition;

            if (type === "sma-crossover") {
              definition = createSmaCrossover(stratParams);
            } else if (type === "rsi-mean-reversion") {
              definition = createRsiMeanReversion(stratParams);
            } else if (type === "bollinger-bands") {
              definition = createBollingerBands(stratParams);
            } else if (type === "macd-divergence") {
              definition = createMacdDivergence(stratParams);
            } else if (type === "trend-following-momentum") {
              definition = createTrendFollowingMomentum(stratParams);
            } else if (type === "volatility-mean-reversion") {
              definition = createVolatilityMeanReversion(stratParams);
            } else if (type === "regime-adaptive") {
              definition = createRegimeAdaptive(stratParams);
            } else if (type === "multi-timeframe-confluence") {
              definition = createMultiTimeframeConfluence(stratParams);
            } else if (type === "risk-parity-triple-screen") {
              definition = createRiskParityTripleScreen(stratParams);
            } else if (type === "custom") {
              const rules = params.rules as { buy: string; sell: string } | undefined;
              if (!rules?.buy || !rules?.sell) {
                return json({
                  error: "Custom strategies require 'rules' with 'buy' and 'sell' expressions",
                });
              }
              const rawParams = (params.customParams ?? stratParams) as Record<string, unknown>;
              // Validate all custom params are numeric
              const customParams: Record<string, number> = {};
              for (const [k, v] of Object.entries(rawParams)) {
                const num = Number(v);
                if (Number.isNaN(num)) {
                  return json({
                    error: `Custom parameter "${k}" must be numeric, got: ${typeof v}`,
                  });
                }
                customParams[k] = num;
              }
              definition = buildCustomStrategy(name, rules, customParams, symbols, timeframes);
            } else {
              return json({ error: `Unknown strategy type: ${type}` });
            }

            // Override metadata
            definition.id = `${type}-${Date.now()}`;
            definition.name = name;
            definition.symbols = symbols;
            definition.timeframes = timeframes;

            const record = registry.create(definition);

            return json({
              created: true,
              id: record.id,
              name: record.name,
              level: record.level,
              parameters: definition.parameters,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_strategy_create"] },
    );

    // --- fin_strategy_list ---
    api.registerTool(
      {
        name: "fin_strategy_list",
        label: "List Strategies",
        description: "List registered trading strategies with their status and metrics",
        parameters: Type.Object({
          level: Type.Optional(
            Type.Unsafe<"L0_INCUBATE" | "L1_BACKTEST" | "L2_PAPER" | "L3_LIVE" | "KILLED">({
              type: "string",
              enum: ["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER", "L3_LIVE", "KILLED"],
              description: "Filter by strategy level",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const level = params.level as string | undefined;
            const strategies = registry.list(level ? { level: level as "L0_INCUBATE" } : undefined);

            const summary = strategies.map((s) => ({
              id: s.id,
              name: s.name,
              level: s.level,
              version: s.version,
              lastBacktest: s.lastBacktest
                ? {
                    totalReturn: s.lastBacktest.totalReturn,
                    sharpe: s.lastBacktest.sharpe,
                    maxDrawdown: s.lastBacktest.maxDrawdown,
                    totalTrades: s.lastBacktest.totalTrades,
                  }
                : null,
              lastWalkForward: s.lastWalkForward
                ? { passed: s.lastWalkForward.passed, ratio: s.lastWalkForward.ratio }
                : null,
              updatedAt: new Date(s.updatedAt).toISOString(),
            }));

            return json({ total: summary.length, strategies: summary });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_strategy_list"] },
    );

    // --- fin_backtest_run ---
    api.registerTool(
      {
        name: "fin_backtest_run",
        label: "Run Backtest",
        description: "Run a backtest for a registered strategy using historical data",
        parameters: Type.Object({
          strategyId: Type.String({ description: "ID of the strategy to backtest" }),
          capital: Type.Optional(Type.Number({ description: "Initial capital (default 10000)" })),
          commission: Type.Optional(
            Type.Number({ description: "Commission rate as decimal (e.g. 0.001 = 0.1%)" }),
          ),
          slippage: Type.Optional(
            Type.Number({ description: "Slippage in basis points (e.g. 5 = 0.05%)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const strategyId = params.strategyId as string;
            const record = registry.get(strategyId);
            if (!record) {
              return json({ error: `Strategy ${strategyId} not found` });
            }

            const config: BacktestConfig = {
              capital: (params.capital as number) ?? 10000,
              commissionRate: (params.commission as number) ?? 0.001,
              slippageBps: (params.slippage as number) ?? 5,
              market: record.definition.markets[0] ?? "crypto",
            };

            // Get data from the data provider service
            const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
            const dataProvider = runtime.services?.get?.("fin-data-provider") as
              | {
                  getOHLCV?: (
                    paramsOrSymbol:
                      | {
                          symbol: string;
                          market: "crypto" | "equity" | "commodity";
                          timeframe: string;
                          limit?: number;
                          since?: number;
                        }
                      | string,
                    timeframe?: string,
                    limit?: number,
                  ) => Promise<OhlcvBar[]>;
                }
              | undefined;

            if (!dataProvider?.getOHLCV) {
              return json({
                error: "Data provider not available. Load findoo-datahub-plugin first.",
              });
            }

            const symbol = record.definition.symbols[0] ?? "BTC/USDT";
            const timeframe = record.definition.timeframes[0] ?? "1d";
            const getOHLCV = dataProvider.getOHLCV;
            const ohlcvData =
              getOHLCV.length <= 1
                ? await getOHLCV({
                    symbol,
                    market: config.market,
                    timeframe,
                    limit: 365,
                  })
                : await getOHLCV(symbol, timeframe, 365);

            const result = await engine.run(record.definition, ohlcvData, config);
            registry.updateBacktest(strategyId, result);

            return json({
              strategyId,
              totalReturn: `${result.totalReturn.toFixed(2)}%`,
              sharpe: result.sharpe.toFixed(3),
              sortino: result.sortino.toFixed(3),
              maxDrawdown: `${result.maxDrawdown.toFixed(2)}%`,
              winRate: `${result.winRate.toFixed(1)}%`,
              profitFactor: result.profitFactor.toFixed(2),
              totalTrades: result.totalTrades,
              finalEquity: result.finalEquity.toFixed(2),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_run"] },
    );

    // --- fin_backtest_result ---
    api.registerTool(
      {
        name: "fin_backtest_result",
        label: "Backtest Result",
        description: "Retrieve the last backtest result for a strategy",
        parameters: Type.Object({
          strategyId: Type.String({ description: "ID of the strategy" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const strategyId = params.strategyId as string;
            const record = registry.get(strategyId);
            if (!record) {
              return json({ error: `Strategy ${strategyId} not found` });
            }
            if (!record.lastBacktest) {
              return json({ error: `No backtest result for strategy ${strategyId}` });
            }

            const bt = record.lastBacktest;
            return json({
              strategyId,
              totalReturn: bt.totalReturn,
              sharpe: bt.sharpe,
              sortino: bt.sortino,
              maxDrawdown: bt.maxDrawdown,
              calmar: bt.calmar,
              winRate: bt.winRate,
              profitFactor: bt.profitFactor,
              totalTrades: bt.totalTrades,
              initialCapital: bt.initialCapital,
              finalEquity: bt.finalEquity,
              trades: bt.trades.slice(0, 50), // limit output
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_result"] },
    );

    // --- fin_strategy_tick ---
    // Per-strategy tick memory, persisted across ticks on the record object
    const tickMemory = new Map<string, Map<string, unknown>>();

    api.registerTool(
      {
        name: "fin_strategy_tick",
        label: "Strategy Tick",
        description:
          "Feed the latest market bar to a running strategy. If a signal fires, " +
          "submit order to paper engine (L2) or live engine (L3) automatically.",
        parameters: Type.Object({
          strategyId: Type.String({ description: "Strategy ID to tick" }),
          symbol: Type.Optional(
            Type.String({ description: "Override symbol (default: strategy's first symbol)" }),
          ),
          timeframe: Type.Optional(
            Type.String({ description: "Override timeframe (default: strategy's first)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const strategyId = params.strategyId as string;
            const record = registry.get(strategyId);
            if (!record) return json({ error: `Strategy ${strategyId} not found` });
            if (record.level !== "L2_PAPER" && record.level !== "L3_LIVE") {
              return json({
                error: `Strategy ${strategyId} is ${record.level}, must be L2_PAPER or L3_LIVE to tick`,
              });
            }

            // Get data provider
            const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
            const dataProvider = runtime.services?.get?.("fin-data-provider") as
              | {
                  getOHLCV?: (
                    paramsOrSymbol:
                      | {
                          symbol: string;
                          market: string;
                          timeframe: string;
                          limit?: number;
                        }
                      | string,
                    timeframe?: string,
                    limit?: number,
                  ) => Promise<OhlcvBar[]>;
                }
              | undefined;

            if (!dataProvider?.getOHLCV) {
              return json({ error: "Data provider not available. Load findoo-datahub-plugin." });
            }

            const symbol = (params.symbol as string) ?? record.definition.symbols[0] ?? "BTC/USDT";
            const timeframe =
              (params.timeframe as string) ?? record.definition.timeframes[0] ?? "1h";
            const market = record.definition.markets[0] ?? "crypto";

            const getOHLCV = dataProvider.getOHLCV;
            const ohlcv =
              getOHLCV.length <= 1
                ? await getOHLCV({ symbol, market, timeframe, limit: 200 })
                : await getOHLCV(symbol, timeframe, 200);

            if (!ohlcv || ohlcv.length === 0) {
              return json({ error: `No OHLCV data for ${symbol} ${timeframe}` });
            }

            const latestBar = ohlcv[ohlcv.length - 1]!;
            const indicators = buildIndicatorLib(ohlcv);

            // Get paper engine for portfolio state
            const paperEngine = runtime.services?.get?.("fin-paper-engine") as
              | {
                  getAccountState?: (id: string) => {
                    equity: number;
                    cash?: number;
                    orders?: Array<{ strategyId?: string }>;
                  } | null;
                  submitOrder?: (accountId: string, order: unknown, price: number) => unknown;
                  listAccounts?: () => Array<{ id: string; equity: number }>;
                }
              | undefined;

            const portfolio = paperEngine?.getAccountState?.("default") ?? {
              equity: 10000,
              cash: 10000,
            };

            // Ensure per-strategy tick memory
            if (!tickMemory.has(strategyId)) {
              tickMemory.set(strategyId, new Map());
            }

            const ctx: StrategyContext = {
              portfolio: {
                equity: (portfolio as { equity: number }).equity,
                cash:
                  (portfolio as { cash?: number }).cash ?? (portfolio as { equity: number }).equity,
                positions: [],
              },
              history: ohlcv,
              indicators,
              regime: "sideways",
              memory: tickMemory.get(strategyId)!,
              log: () => {},
            };

            // Use regime detector if available
            const regimeDetector = runtime.services?.get?.("fin-regime-detector") as
              | { detect?: (bars: OhlcvBar[]) => string }
              | undefined;
            if (regimeDetector?.detect) {
              ctx.regime = regimeDetector.detect(ohlcv) as typeof ctx.regime;
            }

            // Execute strategy onBar
            const signal = await record.definition.onBar(latestBar, ctx);

            if (!signal) {
              return json({
                strategyId,
                symbol,
                timeframe,
                bar: { timestamp: latestBar.timestamp, close: latestBar.close },
                signal: null,
                action: "hold",
              });
            }

            // Route order based on level
            let orderResult: unknown = null;

            if (record.level === "L2_PAPER") {
              if (paperEngine?.submitOrder) {
                const quantity = ((signal.sizePct / 100) * ctx.portfolio.equity) / latestBar.close;
                orderResult = paperEngine.submitOrder(
                  "default",
                  {
                    symbol: signal.symbol || symbol,
                    side: signal.action === "buy" ? "buy" : "sell",
                    type: signal.orderType,
                    quantity,
                    strategyId,
                  },
                  latestBar.close,
                );
              }
            } else if (record.level === "L3_LIVE") {
              const finCore = runtime.services?.get?.("fin-exchange-registry") as
                | { createOrder?: (...args: unknown[]) => Promise<unknown> }
                | undefined;
              if (finCore?.createOrder) {
                const quantity = ((signal.sizePct / 100) * ctx.portfolio.equity) / latestBar.close;
                orderResult = await finCore.createOrder(
                  signal.symbol || symbol,
                  signal.orderType,
                  signal.action === "buy" ? "buy" : "sell",
                  quantity,
                  signal.limitPrice,
                );
              } else {
                orderResult = { warning: "Live exchange not available, order not submitted" };
              }
            }

            return json({
              strategyId,
              symbol,
              timeframe,
              bar: { timestamp: latestBar.timestamp, close: latestBar.close },
              signal: {
                action: signal.action,
                sizePct: signal.sizePct,
                reason: signal.reason,
                confidence: signal.confidence,
              },
              level: record.level,
              orderResult,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_strategy_tick"] },
    );
  },
};

export default plugin;
