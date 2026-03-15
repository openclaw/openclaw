/**
 * Strategy Discovery Engine — orchestrates Phase A + Phase B.
 *
 * Phase A (deterministic, ~5s): scan markets → regime detection → rule-based
 *   strategy generation → write to registry → fire-and-forget backtests.
 *
 * Phase B (subagent, async): build expert prompt → wake main Agent →
 *   main Agent spawns a subagent via sessions_spawn → subagent runs deep
 *   analysis in its own context window → calls fin_strategy_create.
 */

import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import type { OHLCV, MarketRegime, MarketType } from "../shared/types.js";
import { buildIndicatorLib } from "../strategy/indicator-lib.js";
import type { RemoteBacktestBridge } from "../strategy/remote-backtest-bridge.js";
import type { StrategyRegistry } from "../strategy/strategy-registry.js";
import { generateFromSnapshot } from "./deterministic-seeder.js";
import { buildSubagentTaskPrompt, buildWakeMessage } from "./discovery-prompt-builder.js";
import type {
  DiscoveryConfig,
  DiscoveryMarketSnapshot,
  DiscoveryResult,
  DiscoverySymbolSnapshot,
} from "./types.js";
import { DEFAULT_DISCOVERY_CONFIG } from "./types.js";

/** Minimal data provider interface (matches fin-data-provider service). */
type DataProviderLike = {
  getOHLCV(params: {
    symbol: string;
    market: MarketType;
    timeframe: string;
    limit?: number;
  }): Promise<OHLCV[]>;
};

/** Minimal regime detector interface (matches fin-regime-detector service). */
type RegimeDetectorLike = {
  detect(ohlcv: OHLCV[]): MarketRegime;
};

export interface StrategyDiscoveryDeps {
  dataProviderResolver: () => DataProviderLike | undefined;
  regimeDetectorResolver: () => RegimeDetectorLike | undefined;
  strategyRegistry: StrategyRegistry;
  backtestBridge: RemoteBacktestBridge;
  wakeBridge?: AgentWakeBridge;
  eventStore: AgentEventSqliteStore;
}

export class StrategyDiscoveryEngine {
  private deps: StrategyDiscoveryDeps;

  constructor(deps: StrategyDiscoveryDeps) {
    this.deps = deps;
  }

  /**
   * Run a full discovery cycle.
   * Phase A: deterministic strategies from market data.
   * Phase B: fire subagent wake for LLM deep analysis.
   */
  async discover(config: DiscoveryConfig = DEFAULT_DISCOVERY_CONFIG): Promise<DiscoveryResult> {
    // 1. Scan markets → DiscoveryMarketSnapshot
    const snapshot = await this.scanMarkets(config);

    // 2. Phase A: deterministic seeder
    const deterministicIds = await this.runDeterministicPhase(snapshot, config);

    // 3. Phase B: fire subagent wake (async, non-blocking)
    const subagentWakeFired = this.fireSubagentDiscovery(snapshot, deterministicIds, config);

    // 4. Record discovery event
    this.deps.eventStore.addEvent({
      type: "system",
      title: `策略发现: ${snapshot.symbols.length} 个标的扫描完成`,
      detail:
        `确定性策略 ${deterministicIds.length} 个` +
        (subagentWakeFired ? ", AI 深度分析子 Agent 已触发" : ""),
      status: "completed",
    });

    return { snapshot, deterministicIds, subagentWakeFired };
  }

  /** Scan all watchlist symbols and build a DiscoveryMarketSnapshot. */
  private async scanMarkets(config: DiscoveryConfig): Promise<DiscoveryMarketSnapshot> {
    const dataProvider = this.deps.dataProviderResolver();
    if (!dataProvider) {
      console.warn("[StrategyDiscovery] No data provider available, returning empty snapshot");
      return { timestamp: Date.now(), symbols: [] };
    }

    const regimeDetector = this.deps.regimeDetectorResolver();

    // Build flat target list from watchlist
    const targets = buildTargetList(config);

    // Fetch OHLCV + compute indicators in parallel
    const results = await Promise.allSettled(
      targets.map(async ({ symbol, market, marketLabel }) => {
        const ohlcv = await dataProvider.getOHLCV({
          symbol,
          market: market as MarketType,
          timeframe: "1d",
          limit: config.klineBars,
        });
        return buildSymbolSnapshot(symbol, marketLabel, ohlcv, regimeDetector);
      }),
    );

    const symbols: DiscoverySymbolSnapshot[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        symbols.push(r.value);
      } else if (r.status === "rejected") {
        console.warn("[StrategyDiscovery] Symbol scan failed:", r.reason);
      }
    }

    return { timestamp: Date.now(), symbols };
  }

  /** Phase A: generate deterministic strategies and register them. */
  private async runDeterministicPhase(
    snapshot: DiscoveryMarketSnapshot,
    config: DiscoveryConfig,
  ): Promise<string[]> {
    if (snapshot.symbols.length === 0) return [];

    const definitions = generateFromSnapshot(snapshot.symbols, config.maxDeterministicStrategies);

    const createdIds: string[] = [];
    for (const def of definitions) {
      try {
        // Skip if a strategy with same ID already exists
        if (this.deps.strategyRegistry.get(def.id)) continue;

        this.deps.strategyRegistry.create(def);
        createdIds.push(def.id);

        // Fire-and-forget backtest
        if (config.backtestAfterCreate) {
          void this.deps.backtestBridge
            .runBacktest(def, {
              capital: 10_000,
              commissionRate: 0.001,
              slippageBps: 5,
              market: def.markets[0] ?? "crypto",
            })
            .then((result) => {
              this.deps.strategyRegistry.updateBacktest(def.id, result);
            })
            .catch((err) => {
              console.warn(`[StrategyDiscovery] Backtest failed for ${def.name}:`, err);
            });
        }
      } catch (err) {
        console.error(`[StrategyDiscovery] Failed to create strategy ${def.name}:`, err);
      }
    }

    return createdIds;
  }

  /**
   * Phase B: build subagent task prompt and fire wake event.
   * Always fires when wakeBridge is present — the subagent uses fin_kline/fin_price
   * tools to fetch its own data, so Phase A's data provider is NOT required.
   */
  private fireSubagentDiscovery(
    snapshot: DiscoveryMarketSnapshot,
    deterministicIds: string[],
    config: DiscoveryConfig,
  ): boolean {
    if (!this.deps.wakeBridge) return false;

    // Gather existing strategy names to avoid duplicates
    const existingNames = this.deps.strategyRegistry.list().map((r) => r.name);

    // Build the subagent task prompt — LLM will fetch its own data via tools
    // Phase A snapshots are optional hints (may be empty if data provider unavailable)
    const subagentTask = buildSubagentTaskPrompt(
      config,
      existingNames,
      snapshot.symbols.length > 0 ? snapshot.symbols : undefined,
    );

    // Build the wake message that instructs the main Agent to spawn a subagent
    const wakeMessage = buildWakeMessage(
      snapshot.symbols.length,
      deterministicIds.length,
      subagentTask,
    );

    this.deps.wakeBridge.onDiscoveryScanComplete({
      symbolCount: snapshot.symbols.length,
      deterministicCount: deterministicIds.length,
      wakeMessage,
    });

    return true;
  }
}

/** Build flat target list from the multi-market watchlist. */
function buildTargetList(
  config: DiscoveryConfig,
): Array<{ symbol: string; market: string; marketLabel: string }> {
  const targets: Array<{ symbol: string; market: string; marketLabel: string }> = [];

  for (const s of config.watchlist.crypto) {
    targets.push({ symbol: s, market: "crypto", marketLabel: "crypto" });
  }
  for (const s of config.watchlist.equity) {
    targets.push({ symbol: s, market: "equity", marketLabel: "us-stock" });
  }
  for (const s of config.watchlist.hkStock) {
    targets.push({ symbol: s, market: "equity", marketLabel: "hk-stock" });
  }
  for (const s of config.watchlist.aShare) {
    targets.push({ symbol: s, market: "equity", marketLabel: "a-share" });
  }

  return targets;
}

/** Build a DiscoverySymbolSnapshot from raw OHLCV data. */
function buildSymbolSnapshot(
  symbol: string,
  market: string,
  ohlcv: OHLCV[],
  regimeDetector?: RegimeDetectorLike,
): DiscoverySymbolSnapshot | null {
  if (ohlcv.length < 30) return null; // need minimum data

  const lib = buildIndicatorLib(ohlcv);
  const last = ohlcv.length - 1;
  const close = ohlcv[last]!.close;

  // RSI(14)
  const rsi14Arr = lib.rsi(14);
  const rsi14 = lastValid(rsi14Arr) ?? 50;

  // SMA(50) and SMA(200)
  const sma50Arr = lib.sma(50);
  const sma200Arr = lib.sma(200);
  const sma50 = lastValid(sma50Arr) ?? close;
  const sma200 = lastValid(sma200Arr) ?? close;

  // ATR(14) as % of price
  const atr14Arr = lib.atr(14);
  const atr14 = lastValid(atr14Arr) ?? 0;
  const atrPct = close > 0 ? (atr14 / close) * 100 : 0;

  // 7d and 30d price change
  const change7dPct =
    ohlcv.length >= 7
      ? ((close - ohlcv[last - 7 + 1]!.close) / ohlcv[last - 7 + 1]!.close) * 100
      : 0;
  const change30dPct =
    ohlcv.length >= 30
      ? ((close - ohlcv[last - 30 + 1]!.close) / ohlcv[last - 30 + 1]!.close) * 100
      : 0;

  // Volume 7d average
  const recentVolumes = ohlcv.slice(-7).map((b) => b.volume);
  const volume7dAvg = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

  // Regime detection
  const regime = regimeDetector
    ? regimeDetector.detect(ohlcv)
    : inferRegime(rsi14, sma50, sma200, atrPct);

  return {
    symbol,
    market: market as DiscoverySymbolSnapshot["market"],
    regime,
    close,
    change7dPct,
    change30dPct,
    rsi14,
    sma50,
    sma200,
    atrPct,
    volume7dAvg,
  };
}

/** Simple regime inference when no regime detector service is available. */
function inferRegime(rsi14: number, sma50: number, sma200: number, atrPct: number): string {
  if (atrPct > 5) return "crisis";
  if (atrPct > 3) return "volatile";
  const trendRatio = sma200 > 0 ? sma50 / sma200 : 1;
  if (trendRatio > 1.05 && rsi14 > 50) return "bull";
  if (trendRatio < 0.95 && rsi14 < 50) return "bear";
  return "sideways";
}

/** Get the last non-NaN value from an indicator array. */
function lastValid(arr: number[]): number | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!Number.isNaN(arr[i])) return arr[i];
  }
  return undefined;
}
