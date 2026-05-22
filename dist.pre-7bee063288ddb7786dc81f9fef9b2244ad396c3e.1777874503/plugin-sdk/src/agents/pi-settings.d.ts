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
/**
 * Detect providers whose pi-ai `isContextOverflow` Case 2 (silent overflow)
 * fires on a successful turn and triggers Pi's `_runAutoCompaction` from
 * inside `Session.prompt()`, collapsing `agent.state.messages` before the
 * provider call (openclaw#75799).
 *
 * True on any of: `zai-native` endpoint class, normalized provider id `zai`,
 * a `z-ai/` / `openrouter/z-ai/` model-id namespace prefix, or a bare `glm-`
 * model id (no namespace prefix) — the latter covers in-house gateways that
 * expose Zhipu's GLM family directly without a `z-ai/` qualifier. Intentionally
 * narrow: namespaced GLM ids that route through other providers (e.g.
 * `ollama/glm-*`, `opencode-go/glm-*`) are NOT included because their hosts
 * have their own overflow accounting and may not exhibit the z.ai silent-
 * overflow shape. Other providers documented as silently truncating are not
 * added without a reproducible repro.
 */
export declare function isSilentOverflowProneModel(model: {
    provider?: string | null;
    modelId?: string | null;
    baseUrl?: string | null;
}): boolean;
/**
 * Apply the auto-compaction guard. Callers that reload a `DefaultResourceLoader`
 * MUST call this AGAIN after each `reload()` — `settingsManager.reload()`
 * rehydrates `compaction.enabled` from disk and silently restores Pi's
 * default-on behavior, undoing the guard. Mirrors the existing
 * `applyPiCompactionSettingsFromConfig` re-call pattern at the same sites.
 */
export declare function applyPiAutoCompactionGuard(params: {
    settingsManager: PiSettingsManagerLike;
    contextEngineInfo?: ContextEngineInfo;
    silentOverflowProneProvider?: boolean;
}): {
    supported: boolean;
    disabled: boolean;
};
export {};
