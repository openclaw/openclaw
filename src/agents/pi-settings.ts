import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;
const log = createSubsystemLogger("agents/pi-settings");

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

export function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
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
  contextWindowTokens?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredTriggerTokens = toPositiveInt(compactionCfg?.triggerTokens);
  const configuredTargetTokens = toPositiveInt(compactionCfg?.targetTokens);
  const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
  const configuredKeepRecentTokens =
    configuredTargetTokens ?? toPositiveInt(compactionCfg?.keepRecentTokens);
  const reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg);

  let targetReserveTokensFromTrigger: number | undefined;
  if (configuredTriggerTokens !== undefined) {
    const contextWindowTokens = toPositiveInt(params.contextWindowTokens);
    if (contextWindowTokens === undefined) {
      log.warn(
        "compaction.triggerTokens configured without resolved contextWindowTokens; " +
          "falling back to reserveTokens/current Pi settings for this run.",
      );
    } else {
      const derivedReserveTokens = Math.max(0, contextWindowTokens - configuredTriggerTokens);
      targetReserveTokensFromTrigger = derivedReserveTokens;

      if (derivedReserveTokens <= 0) {
        log.warn(
          `compaction.triggerTokens=${configuredTriggerTokens} exceeds or matches ` +
            `context window ${contextWindowTokens}; reserveTokensFloor/current reserve will clamp ` +
            "the effective threshold for this run.",
        );
      } else if (derivedReserveTokens < reserveTokensFloor) {
        log.warn(
          `compaction.triggerTokens=${configuredTriggerTokens} derives reserveTokens=${derivedReserveTokens}, ` +
            `but reserveTokensFloor=${reserveTokensFloor} raises the effective reserve for this run.`,
        );
      }
    }
  }

  const targetReserveTokens = Math.max(
    targetReserveTokensFromTrigger ?? configuredReserveTokens ?? currentReserveTokens,
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
