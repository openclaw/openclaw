import type { OpenClawConfig } from "../config/config.js";
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
};
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
}): {
    didOverride: boolean;
    compaction: {
        reserveTokens: number;
        keepRecentTokens: number;
    };
};
export {};
