import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

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

/**
 * Resolve a ratio-based token budget sibling field.
 *
 * Precedence (highest to lowest):
 *   1. `share` + `contextWindowTokens` → `Math.floor(contextWindow * share)`
 *   2. `absolute` if set
 *   3. `fallback` (caller-provided default)
 *
 * Designed to support heterogeneous models: one config can carry a `*Share` ratio
 * that scales across 8k, 200k, and 1M context windows instead of locking to a
 * single absolute token count.
 *
 * @param share       fractional share of the context window (0.01–0.9); pass
 *                    `undefined` when only the absolute path should apply.
 * @param absolute    existing absolute-token field; used when share is not set
 *                    or the context window is unknown.
 * @param contextWindowTokens known context window in tokens; when missing, the
 *                    share is ignored and the absolute/fallback path is used.
 * @param fallback    value returned when neither share nor absolute produces a
 *                    usable number.
 */
export function resolveShareBasedTokenBudget(params: {
  share?: number;
  absolute?: number;
  contextWindowTokens?: number;
  fallback: number;
}): number {
  const { share, absolute, contextWindowTokens, fallback } = params;
  if (
    typeof share === "number" &&
    Number.isFinite(share) &&
    share > 0 &&
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  ) {
    const computed = Math.floor(contextWindowTokens * share);
    if (computed > 0) {
      return computed;
    }
  }
  if (typeof absolute === "number" && Number.isFinite(absolute) && absolute >= 0) {
    return Math.floor(absolute);
  }
  return fallback;
}

export function resolveCompactionReserveTokensFloor(
  cfg?: OpenClawConfig,
  contextWindowTokens?: number,
): number {
  const compaction = cfg?.agents?.defaults?.compaction;
  const share = compaction?.reserveTokensFloorShare;
  const raw = compaction?.reserveTokensFloor;
  if (
    typeof share === "number" &&
    Number.isFinite(share) &&
    share > 0 &&
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  ) {
    const computed = Math.floor(contextWindowTokens * share);
    if (computed >= 0) {
      return computed;
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
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
  /**
   * Model context window in tokens (e.g. 200_000 for Claude/GLM, 1_000_000 for Kimi K2).
   * When provided, `*Share` sibling fields are resolved against this window and win
   * over their absolute counterparts. When omitted, only absolute fields apply and
   * behavior matches pre-share configs exactly.
   */
  contextWindowTokens?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredReserveTokensAbsolute = toNonNegativeInt(compactionCfg?.reserveTokens);
  const configuredReserveTokens =
    typeof compactionCfg?.reserveTokensShare === "number" &&
    compactionCfg.reserveTokensShare > 0 &&
    typeof params.contextWindowTokens === "number" &&
    params.contextWindowTokens > 0
      ? resolveShareBasedTokenBudget({
          share: compactionCfg.reserveTokensShare,
          absolute: configuredReserveTokensAbsolute,
          contextWindowTokens: params.contextWindowTokens,
          fallback: configuredReserveTokensAbsolute ?? currentReserveTokens,
        })
      : configuredReserveTokensAbsolute;

  const configuredKeepRecentTokensAbsolute = toPositiveInt(compactionCfg?.keepRecentTokens);
  const configuredKeepRecentTokens =
    typeof compactionCfg?.keepRecentTokensShare === "number" &&
    compactionCfg.keepRecentTokensShare > 0 &&
    typeof params.contextWindowTokens === "number" &&
    params.contextWindowTokens > 0
      ? resolveShareBasedTokenBudget({
          share: compactionCfg.keepRecentTokensShare,
          absolute: configuredKeepRecentTokensAbsolute,
          contextWindowTokens: params.contextWindowTokens,
          fallback: configuredKeepRecentTokensAbsolute ?? currentKeepRecentTokens,
        })
      : configuredKeepRecentTokensAbsolute;

  const reserveTokensFloor = resolveCompactionReserveTokensFloor(
    params.cfg,
    params.contextWindowTokens,
  );

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
