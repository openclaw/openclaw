export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;
export function ensurePiCompactionReserveTokens(params) {
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
export function resolveCompactionReserveTokensFloor(cfg) {
    const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        return Math.floor(raw);
    }
    return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}
function toNonNegativeInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}
function toPositiveInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
}
export function applyPiCompactionSettingsFromConfig(params) {
    const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
    const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
    const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
    const reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg);
    const targetReserveTokens = Math.max(configuredReserveTokens ?? currentReserveTokens, reserveTokensFloor);
    const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;
    const overrides = {};
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
