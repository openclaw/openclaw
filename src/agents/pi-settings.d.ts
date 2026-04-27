import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
export declare const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;
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
/**
 * Ensures the compaction reserve tokens are at least the specified minimum.
 * Note: This function is not context-aware and uses an uncapped floor.
 * If called for small-context models without threading `contextTokenBudget`,
 * it may re-introduce context overflow issues.
 */
export declare function ensurePiCompactionReserveTokens(params: {
    settingsManager: PiSettingsManagerLike;
    minReserveTokens?: number;
}): {
    didOverride: boolean;
    reserveTokens: number;
};
export declare function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number;
export declare function applyPiCompactionSettingsFromConfig(params: {
    settingsManager: PiSettingsManagerLike;
    cfg?: OpenClawConfig;
    /** When known, the resolved context window budget for the current model. */
    contextTokenBudget?: number;
}): {
    didOverride: boolean;
    compaction: {
        reserveTokens: number;
        keepRecentTokens: number;
    };
};
/** Decide whether Pi's internal auto-compaction should be disabled for this run. */
export declare function shouldDisablePiAutoCompaction(params: {
    contextEngineInfo?: ContextEngineInfo;
}): boolean;
/** Disable Pi auto-compaction via settings when a context engine owns compaction. */
export declare function applyPiAutoCompactionGuard(params: {
    settingsManager: PiSettingsManagerLike;
    contextEngineInfo?: ContextEngineInfo;
}): {
    supported: boolean;
    disabled: boolean;
};
export {};
