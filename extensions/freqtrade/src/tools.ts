/**
 * Freqtrade tool definitions for OpenClaw.
 */
import { Type } from "@sinclair/typebox";
import { FreqtradeClient } from "./client.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";

interface PluginConfig {
  apiUrl?: string;
  username?: string;
  password?: string;
  dryRun?: boolean;
  exchange?: string;
}

function getClient(api: OpenClawPluginApi): FreqtradeClient {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const apiUrl = cfg.apiUrl?.trim();
  const username = cfg.username?.trim();
  const password = cfg.password?.trim();

  if (!apiUrl || !username || !password) {
    throw new Error(
      "Freqtrade plugin not configured. Set apiUrl, username, and password in openclaw.json plugins.freqtrade config.",
    );
  }

  return new FreqtradeClient({ apiUrl, username, password });
}

function isDryRun(api: OpenClawPluginApi): boolean {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  // Default to true (safe mode) if not explicitly set to false
  return cfg.dryRun !== false;
}

export function createFreqtradeTools(api: OpenClawPluginApi) {
  return [
    {
      name: "freqtrade_status",
      label: "Freqtrade Status",
      description: "Get the current bot status including open trades and profit summary.",
      parameters: Type.Object({}),
      async execute() {
        const client = getClient(api);
        const data = await client.getStatus();
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_balance",
      label: "Freqtrade Balance",
      description: "Get wallet balance breakdown per currency on the connected exchange.",
      parameters: Type.Object({}),
      async execute() {
        const client = getClient(api);
        const data = await client.getBalance();
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_trades",
      label: "Freqtrade Trades",
      description: "List recent trades with profit/loss information.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max trades to return (default 50)." })),
      }),
      async execute(_id: string, params: { limit?: number }) {
        const client = getClient(api);
        const data = await client.getTrades(params.limit ?? 50);
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_performance",
      label: "Freqtrade Performance",
      description: "Get per-pair trading performance statistics.",
      parameters: Type.Object({}),
      async execute() {
        const client = getClient(api);
        const data = await client.getPerformance();
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_strategies",
      label: "Freqtrade Strategies",
      description: "List available trading strategies loaded in the freqtrade bot.",
      parameters: Type.Object({}),
      async execute() {
        const client = getClient(api);
        const data = await client.getStrategies();
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_forcebuy",
      label: "Freqtrade Force Buy",
      description:
        "⚠️ REAL MONEY OPERATION — Force-open a trading position. Blocked when dryRun is enabled (default). Set dryRun: false in plugin config to allow.",
      parameters: Type.Object({
        pair: Type.String({ description: "Trading pair (e.g. BTC/USDT)." }),
        price: Type.Optional(Type.Number({ description: "Optional limit price." })),
      }),
      async execute(_id: string, params: { pair: string; price?: number }) {
        if (isDryRun(api)) {
          return {
            text: "🚫 Force buy blocked: dryRun mode is enabled. Set dryRun: false in freqtrade plugin config to allow real trades.",
          };
        }
        const client = getClient(api);
        const data = await client.forceBuy(params.pair, params.price);
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_forcesell",
      label: "Freqtrade Force Sell",
      description:
        "⚠️ REAL MONEY OPERATION — Force-close a trading position. Blocked when dryRun is enabled (default). Set dryRun: false in plugin config to allow.",
      parameters: Type.Object({
        trade_id: Type.Number({ description: "Trade ID to force-close." }),
      }),
      async execute(_id: string, params: { trade_id: number }) {
        if (isDryRun(api)) {
          return {
            text: "🚫 Force sell blocked: dryRun mode is enabled. Set dryRun: false in freqtrade plugin config to allow real trades.",
          };
        }
        const client = getClient(api);
        const data = await client.forceSell(params.trade_id);
        return { text: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: "freqtrade_backtest",
      label: "Freqtrade Backtest",
      description:
        "Run a backtest for a strategy over a given timerange. Use freqtrade_strategies to list available strategies first.",
      parameters: Type.Object({
        strategy: Type.String({ description: "Strategy name to backtest." }),
        timerange: Type.String({
          description: "Time range (e.g. '20240101-20240601' or '20240101-').",
        }),
      }),
      async execute(_id: string, params: { strategy: string; timerange: string }) {
        const client = getClient(api);
        const data = await client.runBacktest(params.strategy, params.timerange);
        return { text: JSON.stringify(data, null, 2) };
      },
    },
  ];
}
