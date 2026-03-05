import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBollingerBands } from "./builtin-strategies/bollinger-bands.js";
import { buildCustomStrategy } from "./builtin-strategies/custom-rule-engine.js";
import { createMacdDivergence } from "./builtin-strategies/macd-divergence.js";
import { createMultiTimeframeConfluence } from "./builtin-strategies/multi-timeframe-confluence.js";
import { createRegimeAdaptive } from "./builtin-strategies/regime-adaptive.js";
import { createRiskParityTripleScreen } from "./builtin-strategies/risk-parity-triple-screen.js";
import { createRsiMeanReversion } from "./builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "./builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "./builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "./builtin-strategies/volatility-mean-reversion.js";
import type {
  BacktestResult,
  StrategyDefinition,
  StrategyLevel,
  StrategyRecord,
  StrategyStatus,
  WalkForwardResult,
} from "./types.js";

/** Map strategy type prefix → factory that restores onBar/init/onDayEnd functions. */
function hydrateDefinition(def: StrategyDefinition): StrategyDefinition {
  if (typeof def.onBar === "function") return def; // already hydrated

  const type = def.id.replace(/-\d+$/, ""); // strip timestamp suffix e.g. "sma-crossover-1709..." → "sma-crossover"
  const params = def.parameters ?? {};

  const factories: Record<string, () => StrategyDefinition> = {
    "sma-crossover": () => createSmaCrossover(params),
    "rsi-mean-reversion": () => createRsiMeanReversion(params),
    "bollinger-bands": () => createBollingerBands(params),
    "macd-divergence": () => createMacdDivergence(params),
    "trend-following-momentum": () => createTrendFollowingMomentum(params),
    "volatility-mean-reversion": () => createVolatilityMeanReversion(params),
    "regime-adaptive": () => createRegimeAdaptive(params),
    "multi-timeframe-confluence": () => createMultiTimeframeConfluence(params),
    "risk-parity-triple-screen": () => createRiskParityTripleScreen(params),
  };

  const factory = factories[type];
  if (factory) {
    const fresh = factory();
    // Restore functions from the factory, keep serialized metadata from disk
    def.onBar = fresh.onBar;
    if (fresh.init) def.init = fresh.init;
    if (fresh.onDayEnd) def.onDayEnd = fresh.onDayEnd;
    return def;
  }

  // Custom rule-engine strategies: type prefix is "custom"
  if (type === "custom" && (def as Record<string, unknown>)._rules) {
    const rules = (def as Record<string, unknown>)._rules as { buy: string; sell: string };
    const fresh = buildCustomStrategy(def.name, rules, params, def.symbols, def.timeframes);
    def.onBar = fresh.onBar;
    if (fresh.init) def.init = fresh.init;
    return def;
  }

  return def; // unknown type — leave as-is (will fail on onBar call with clear error)
}

/**
 * Persistent strategy registry backed by a JSON file.
 * Stores strategy metadata, backtest results, and walk-forward results.
 */
export class StrategyRegistry {
  private records: Map<string, StrategyRecord> = new Map();

  constructor(private filePath: string) {
    this.load();
  }

  /** Create a new strategy record. Returns the created record. */
  create(definition: StrategyDefinition): StrategyRecord {
    const now = Date.now();
    const record: StrategyRecord = {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      level: "L0_INCUBATE",
      definition,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(definition.id, record);
    this.save();
    return record;
  }

  /** Get a strategy record by ID. */
  get(id: string): StrategyRecord | undefined {
    return this.records.get(id);
  }

  /** List all strategies, optionally filtered by level. */
  list(filter?: { level?: StrategyLevel }): StrategyRecord[] {
    const all = [...this.records.values()];
    if (filter?.level) {
      return all.filter((r) => r.level === filter.level);
    }
    return all;
  }

  /** Update the promotion level of a strategy. */
  updateLevel(id: string, level: StrategyLevel): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Strategy ${id} not found`);
    record.level = level;
    record.updatedAt = Date.now();
    this.save();
  }

  /** Store a backtest result for a strategy. */
  updateBacktest(id: string, result: BacktestResult): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Strategy ${id} not found`);
    record.lastBacktest = result;
    record.updatedAt = Date.now();
    this.save();
  }

  /** Store a walk-forward result for a strategy. */
  updateWalkForward(id: string, result: WalkForwardResult): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Strategy ${id} not found`);
    record.lastWalkForward = result;
    record.updatedAt = Date.now();
    this.save();
  }

  /** Update the running status of a strategy. */
  updateStatus(id: string, status: StrategyStatus): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Strategy ${id} not found`);
    record.status = status;
    record.updatedAt = Date.now();
    this.save();
  }

  /** Persist current state to disk. */
  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = [...this.records.values()];
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Load state from disk, re-hydrating strategy functions lost in JSON serialization. */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as StrategyRecord[];
      this.records.clear();
      for (const record of data) {
        record.definition = hydrateDefinition(record.definition);
        this.records.set(record.id, record);
      }
    } catch {
      // Corrupted file — start fresh
      this.records.clear();
    }
  }
}
