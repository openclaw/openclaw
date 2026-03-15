import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { resolveContextTokensForModel } from "./context.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

/**
 * Calculates adaptive reserveTokensFloor based on model context window size.
 * Uses tiered strategy to ensure adequate headroom for compaction API calls.
 *
 * Tier 1 (≤64k): Fixed 20k floor - sufficient for small models
 * Tier 2 (64k-256k): 10% of context window - balances safety and efficiency
 * Tier 3 (>256k): 5% with 30k minimum - ensures meaningful buffer for large models
 *
 * Examples:
 * - GPT-4 (8k): 20k floor
 * - GPT-4o (128k): 12.8k → 20k (min applies)
 * - Claude 3.5 (200k): 20k floor
 * - Kimi K2.5 (262k): 26k floor (vs 20k default)
 * - Gemini 1M: 50k floor (vs 20k default)
 */
export function calculateAdaptiveReserveTokensFloor(contextWindow: number): number {
  // Small models: fixed 20k floor
  if (contextWindow <= 65536) {
    return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  }

  // Medium models: 10% buffer
  if (contextWindow <= 262144) {
    const calculated = Math.floor(contextWindow * 0.1);
    // Don't go below default for medium models
    return Math.max(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR, calculated);
  }

  // Large models: 5% with 30k minimum
  const calculated = Math.floor(contextWindow * 0.05);
  return Math.max(30000, calculated);
}

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
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

export function resolveCompactionReserveTokensFloor(
  cfg?: OpenClawConfig,
  contextWindow?: number,
): number {
  // User-defined override takes highest precedence
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }

  // Use adaptive calculation if context window is available
  if (typeof contextWindow === "number" && contextWindow > 0) {
    return calculateAdaptiveReserveTokensFloor(contextWindow);
  }

  // Fall back to default for backward compatibility
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function applyPiCompactionSettingsFromConfig(params: {
  settingsManager: PiSettingsManagerLike;
  cfg?: OpenClawConfig;
  contextWindow?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
  const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);

  // Try to get context window from model config if not provided
  let contextWindow = params.contextWindow;
  if (contextWindow === undefined && params.cfg) {
    const primaryModel = params.cfg.agents?.defaults?.model?.primary;
    if (primaryModel) {
      contextWindow = resolveContextTokensForModel({
        cfg: params.cfg,
        model: primaryModel,
      });
    }
  }

  const reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg, contextWindow);

  const targetReserveTokens = Math.max(
    configuredReserveTokens ?? currentReserveTokens,
    reserveTokensFloor,
  );
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const didOverride = Object.keys(overrides).length > 0;
  if (didOverride) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }

  return {
    didOverride,
    compaction: {
      reserveTokens: targetReserveTokens,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

/** Decide whether Pi's internal auto-compaction should be disabled for this run. */
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
}): boolean {
  return params.contextEngineInfo?.ownsCompaction === true;
}

/** Disable Pi auto-compaction via settings when a context engine owns compaction. */
export function applyPiAutoCompactionGuard(params: {
  settingsManager: PiSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
}): { supported: boolean; disabled: boolean } {
  const disable = shouldDisablePiAutoCompaction({
    contextEngineInfo: params.contextEngineInfo,
  });
  const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
  if (!disable || !hasMethod) {
    return { supported: hasMethod, disabled: false };
  }
  params.settingsManager.setCompactionEnabled!(false);
  return { supported: true, disabled: true };
}
