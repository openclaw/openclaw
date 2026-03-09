import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BacktestResult,
  StrategyDefinition,
  StrategyLevel,
  StrategyRecord,
  StrategyStatus,
  WalkForwardResult,
} from "./types.js";

/**
 * Increment version string. Supports semver (x.y.z) and simple numeric versions.
 */
function incrementVersion(version: string): string {
  const semverMatch = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (semverMatch) {
    const [, major, minor, patch] = semverMatch;
    return `${major}.${minor}.${Number(patch) + 1}`;
  }
  const numericMatch = version.match(/^(\d+)$/);
  if (numericMatch) {
    return String(Number(numericMatch[1]) + 1);
  }
  const doubleMatch = version.match(/^(\d+)\.(\d+)$/);
  if (doubleMatch) {
    return `${doubleMatch[1]}.${Number(doubleMatch[2]) + 1}`;
  }
  return version + ".1";
}

/**
 * Deep compare two objects to detect changes.
 * Only compares serializable fields (ignores functions like onBar/init/onDayEnd).
 */
function hasDefinitionChangeded(oldDef: StrategyDefinition, newDef: StrategyDefinition): boolean {
  const oldSerializable = {
    id: oldDef.id,
    name: oldDef.name,
    version: oldDef.version,
    markets: oldDef.markets,
    symbols: oldDef.symbols,
    timeframes: oldDef.timeframes,
    parameters: oldDef.parameters,
    parameterRanges: oldDef.parameterRanges,
  };
  const newSerializable = {
    id: newDef.id,
    name: newDef.name,
    version: newDef.version,
    markets: newDef.markets,
    symbols: newDef.symbols,
    timeframes: newDef.timeframes,
    parameters: newDef.parameters,
    parameterRanges: newDef.parameterRanges,
  };
  return JSON.stringify(oldSerializable) !== JSON.stringify(newSerializable);
}

/**
 * Persistent strategy registry backed by a JSON file.
 * Stores strategy metadata, backtest results, and walk-forward results.
 */
export class StrategyRegistry {
  private records: Map<string, StrategyRecord> = new Map();
  private definitionSnapshots: Map<string, string> = new Map();

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
    this.definitionSnapshots.set(definition.id, JSON.stringify(definition));
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

  /** Update the definition of a strategy. Increments version if definition changed. */
  updateDefinition(id: string, definition: StrategyDefinition): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Strategy ${id} not found`);

    const oldDefinition = record.definition;
    if (hasDefinitionChangeded(oldDefinition, definition)) {
      record.definition = definition;
      record.version = incrementVersion(record.version);
      record.updatedAt = Date.now();
      this.definitionSnapshots.set(id, JSON.stringify(definition));
      this.save();
    }
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

  /** Load state from disk. */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as StrategyRecord[];
      this.records.clear();
      this.definitionSnapshots.clear();
      for (const record of data) {
        this.records.set(record.id, record);
        this.definitionSnapshots.set(record.id, JSON.stringify(record.definition));
      }
    } catch {
      // Corrupted file — start fresh
      this.records.clear();
      this.definitionSnapshots.clear();
    }
  }
}
