import type { OpenClawConfig } from "../config/config.js";
import type { AgentBackgroundOptimizationConfig } from "../config/types.agent-defaults.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 40_000;

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  applyOverrides: (overrides: { compaction: { reserveTokens: number } }) => void;
};

export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
}): { didOverride: boolean; reserveTokens: number } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();

  if (current >= minReserveTokens) {
    return { didOverride: false, reserveTokens: current };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: minReserveTokens },
  });

  return { didOverride: true, reserveTokens: minReserveTokens };
}

export function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

/** Resolved background optimization settings with concrete defaults. */
export type ResolvedBackgroundOptimization = Required<AgentBackgroundOptimizationConfig>;

const BG_OPT_DEFAULTS: ResolvedBackgroundOptimization = {
  verbatimTurns: 30,
  targetWaterLevel: 0.5,
  summaryBudgetRatio: 0.25,
  optimizeAfterTurns: 15,
  optimizeIntervalMin: 20,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Resolve background optimization config with validated defaults. */
export function resolveBackgroundOptimization(
  cfg?: OpenClawConfig,
): ResolvedBackgroundOptimization {
  const raw = cfg?.agents?.defaults?.compaction?.backgroundOptimization;
  if (!raw) return { ...BG_OPT_DEFAULTS };
  return {
    verbatimTurns: clampNumber(raw.verbatimTurns, 1, 200, BG_OPT_DEFAULTS.verbatimTurns),
    targetWaterLevel: clampNumber(raw.targetWaterLevel, 0.1, 0.9, BG_OPT_DEFAULTS.targetWaterLevel),
    summaryBudgetRatio: clampNumber(
      raw.summaryBudgetRatio,
      0.05,
      0.5,
      BG_OPT_DEFAULTS.summaryBudgetRatio,
    ),
    optimizeAfterTurns: clampNumber(
      raw.optimizeAfterTurns,
      1,
      100,
      BG_OPT_DEFAULTS.optimizeAfterTurns,
    ),
    optimizeIntervalMin: clampNumber(
      raw.optimizeIntervalMin,
      1,
      1440,
      BG_OPT_DEFAULTS.optimizeIntervalMin,
    ),
  };
}
