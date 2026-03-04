/**
 * Strategy tools: fin_strategy_create, fin_strategy_list, fin_backtest_run
 * Basic strategy management and backtesting for fin-core (open source).
 * Uses fin-strategy-registry and fin-backtest-engine services if available.
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { json } from "./json-helper.js";

/** Minimal strategy registry interface. */
interface StrategyRegistryLike {
  create(definition: Record<string, unknown>): unknown;
  list(): unknown[];
  get(id: string): unknown | undefined;
}

/** Minimal backtest engine interface. */
interface BacktestEngineLike {
  run(config: Record<string, unknown>): Promise<unknown>;
}

function getStrategyRegistry(api: OpenClawPluginApi): StrategyRegistryLike | undefined {
  return api.runtime.services.get("fin-strategy-registry") as StrategyRegistryLike | undefined;
}

function getBacktestEngine(api: OpenClawPluginApi): BacktestEngineLike | undefined {
  return api.runtime.services.get("fin-backtest-engine") as BacktestEngineLike | undefined;
}

export function registerStrategyTools(api: OpenClawPluginApi): void {
  // ── fin_strategy_create ──
  api.registerTool(
    {
      name: "fin_strategy_create",
      label: "Create Strategy",
      description:
        "Create a new trading strategy definition. " +
        "The strategy starts at L0 (incubate) and can be promoted through backtest → paper → live.",
      parameters: Type.Object({
        name: Type.String({ description: "Strategy name (e.g. 'SMA Crossover', 'Vol Adjusted Momentum')" }),
        description: Type.Optional(Type.String({ description: "Strategy description" })),
        symbol: Type.String({ description: "Target trading pair (e.g. 'BTC/USDT', 'AAPL')" }),
        timeframe: Type.Optional(
          Type.String({ description: "Candle timeframe (e.g. '1h', '4h', '1d'). Defaults to '1d'." }),
        ),
        parameters: Type.Optional(
          Type.String({
            description: "Strategy parameters as JSON string (e.g. '{\"fastPeriod\": 10, \"slowPeriod\": 30}')",
          }),
        ),
        rules: Type.Optional(
          Type.String({
            description: "Trading rules as natural language or pseudocode",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const registry = getStrategyRegistry(api);
          if (!registry) {
            return json({
              success: false,
              error: "Strategy engine not available. Enable the fin-strategy-engine plugin.",
            });
          }

          let strategyParams: Record<string, unknown> = {};
          if (params.parameters) {
            try {
              strategyParams = JSON.parse(params.parameters as string) as Record<string, unknown>;
            } catch {
              return json({ success: false, error: "Invalid JSON in 'parameters' field." });
            }
          }

          const strategy = registry.create({
            name: params.name,
            description: params.description ?? "",
            symbol: params.symbol,
            timeframe: params.timeframe ?? "1d",
            parameters: strategyParams,
            rules: params.rules ?? "",
            level: "L0_INCUBATE",
            status: "idle",
          });

          return json({
            success: true,
            message: `Strategy "${params.name}" created at L0 (incubate).`,
            strategy,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_strategy_create"] },
  );

  // ── fin_strategy_list ──
  api.registerTool(
    {
      name: "fin_strategy_list",
      label: "List Strategies",
      description: "List all trading strategies with their current level and status.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: Record<string, unknown>) {
        try {
          const registry = getStrategyRegistry(api);
          if (!registry) {
            return json({
              success: false,
              error: "Strategy engine not available. Enable the fin-strategy-engine plugin.",
            });
          }

          const strategies = registry.list();
          return json({
            success: true,
            count: strategies.length,
            strategies,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_strategy_list"] },
  );

  // ── fin_backtest_run ──
  api.registerTool(
    {
      name: "fin_backtest_run",
      label: "Run Backtest",
      description:
        "Run a backtest on a strategy using the local engine. " +
        "Returns performance metrics (Sharpe, MaxDD, WinRate, total return).",
      parameters: Type.Object({
        strategyId: Type.String({ description: "Strategy ID to backtest" }),
        symbol: Type.Optional(
          Type.String({ description: "Trading pair. Defaults to strategy's configured symbol." }),
        ),
        startDate: Type.Optional(
          Type.String({ description: "Backtest start date (YYYY-MM-DD). Defaults to 1 year ago." }),
        ),
        endDate: Type.Optional(
          Type.String({ description: "Backtest end date (YYYY-MM-DD). Defaults to today." }),
        ),
        initialCapital: Type.Optional(
          Type.Number({ description: "Initial capital in USD. Defaults to 10000." }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const registry = getStrategyRegistry(api);
          const engine = getBacktestEngine(api);

          if (!registry) {
            return json({
              success: false,
              error: "Strategy engine not available. Enable the fin-strategy-engine plugin.",
            });
          }
          if (!engine) {
            return json({
              success: false,
              error: "Backtest engine not available. Enable the fin-strategy-engine plugin.",
            });
          }

          const strategy = registry.get(params.strategyId as string);
          if (!strategy) {
            return json({
              success: false,
              error: `Strategy "${params.strategyId}" not found.`,
            });
          }

          const result = await engine.run({
            strategy,
            symbol: params.symbol,
            startDate: params.startDate,
            endDate: params.endDate,
            initialCapital: params.initialCapital ?? 10000,
          });

          return json({
            success: true,
            strategyId: params.strategyId,
            result,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_backtest_run"] },
  );
}
