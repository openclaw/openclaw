import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const DEFAULT_MEMORY_DREAMING_ENABLED = false;
export declare const DEFAULT_MEMORY_DREAMING_TIMEZONE: undefined;
export declare const DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING = false;
export declare const DEFAULT_MEMORY_DREAMING_STORAGE_MODE = "separate";
export declare const DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS = false;
export declare const DEFAULT_MEMORY_DREAMING_FREQUENCY = "0 3 * * *";
export declare const DEFAULT_MEMORY_DREAMING_PLUGIN_ID = "memory-core";
export declare const MANAGED_MEMORY_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
export declare const MANAGED_MEMORY_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
export declare const MEMORY_DREAMING_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
export declare const LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME = "Memory Light Dreaming";
export declare const LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
export declare const LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
export declare const LEGACY_MEMORY_REM_DREAMING_CRON_NAME = "Memory REM Dreaming";
export declare const LEGACY_MEMORY_REM_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
export declare const LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
export declare const DEFAULT_MEMORY_LIGHT_DREAMING_CRON_EXPR = "0 */6 * * *";
export declare const DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS = 2;
export declare const DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT = 100;
export declare const DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY = 0.9;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_CRON_EXPR = "0 3 * * *";
export declare const DEFAULT_MEMORY_DEEP_DREAMING_LIMIT = 10;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE = 0.8;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT = 3;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES = 3;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS = 30;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_ENABLED = true;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_TRIGGER_BELOW_HEALTH = 0.35;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_LOOKBACK_DAYS = 30;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MAX_CANDIDATES = 20;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MIN_CONFIDENCE = 0.9;
export declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE = 0.97;
export declare const DEFAULT_MEMORY_REM_DREAMING_CRON_EXPR = "0 5 * * 0";
export declare const DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS = 7;
export declare const DEFAULT_MEMORY_REM_DREAMING_LIMIT = 10;
export declare const DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH = 0.75;
export declare const DEFAULT_MEMORY_DREAMING_SPEED = "balanced";
export declare const DEFAULT_MEMORY_DREAMING_THINKING = "medium";
export declare const DEFAULT_MEMORY_DREAMING_BUDGET = "medium";
export type MemoryDreamingSpeed = "fast" | "balanced" | "slow";
export type MemoryDreamingThinking = "low" | "medium" | "high";
export type MemoryDreamingBudget = "cheap" | "medium" | "expensive";
export type MemoryDreamingStorageMode = "inline" | "separate" | "both";
export type MemoryLightDreamingSource = "daily" | "sessions" | "recall";
export type MemoryDeepDreamingSource = "daily" | "memory" | "sessions" | "logs" | "recall";
export type MemoryRemDreamingSource = "memory" | "daily" | "deep";
export type MemoryDreamingExecutionConfig = {
    speed: MemoryDreamingSpeed;
    thinking: MemoryDreamingThinking;
    budget: MemoryDreamingBudget;
    model?: string;
    maxOutputTokens?: number;
    temperature?: number;
    timeoutMs?: number;
};
export type MemoryDreamingStorageConfig = {
    mode: MemoryDreamingStorageMode;
    separateReports: boolean;
};
export type MemoryLightDreamingConfig = {
    enabled: boolean;
    cron: string;
    lookbackDays: number;
    limit: number;
    dedupeSimilarity: number;
    sources: MemoryLightDreamingSource[];
    execution: MemoryDreamingExecutionConfig;
};
export type MemoryDeepDreamingRecoveryConfig = {
    enabled: boolean;
    triggerBelowHealth: number;
    lookbackDays: number;
    maxRecoveredCandidates: number;
    minRecoveryConfidence: number;
    autoWriteMinConfidence: number;
};
export type MemoryDeepDreamingConfig = {
    enabled: boolean;
    cron: string;
    limit: number;
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
    recencyHalfLifeDays: number;
    maxAgeDays?: number;
    sources: MemoryDeepDreamingSource[];
    recovery: MemoryDeepDreamingRecoveryConfig;
    execution: MemoryDreamingExecutionConfig;
};
export type MemoryRemDreamingConfig = {
    enabled: boolean;
    cron: string;
    lookbackDays: number;
    limit: number;
    minPatternStrength: number;
    sources: MemoryRemDreamingSource[];
    execution: MemoryDreamingExecutionConfig;
};
export type MemoryDreamingPhaseName = "light" | "deep" | "rem";
export type MemoryDreamingConfig = {
    enabled: boolean;
    frequency: string;
    timezone?: string;
    verboseLogging: boolean;
    storage: MemoryDreamingStorageConfig;
    execution: {
        defaults: MemoryDreamingExecutionConfig;
    };
    phases: {
        light: MemoryLightDreamingConfig;
        deep: MemoryDeepDreamingConfig;
        rem: MemoryRemDreamingConfig;
    };
};
export type MemoryDreamingWorkspace = {
    workspaceDir: string;
    agentIds: string[];
};
export type MemoryDreamingWorkspaceOptions = {
    primaryWorkspaceDir?: string | null;
    primaryAgentId?: string | null;
};
export declare function resolveMemoryDreamingPluginId(cfg: OpenClawConfig | Record<string, unknown> | undefined): string;
export declare function resolveMemoryDreamingPluginConfig(cfg: OpenClawConfig | Record<string, unknown> | undefined): Record<string, unknown> | undefined;
/** @deprecated Use resolveMemoryDreamingPluginConfig. */
export declare const resolveMemoryCorePluginConfig: typeof resolveMemoryDreamingPluginConfig;
export declare function resolveMemoryDreamingConfig(params: {
    pluginConfig?: Record<string, unknown>;
    cfg?: OpenClawConfig;
}): MemoryDreamingConfig;
export declare function resolveMemoryDeepDreamingConfig(params: {
    pluginConfig?: Record<string, unknown>;
    cfg?: OpenClawConfig;
}): MemoryDeepDreamingConfig & {
    timezone?: string;
    verboseLogging: boolean;
    storage: MemoryDreamingStorageConfig;
};
export declare function resolveMemoryLightDreamingConfig(params: {
    pluginConfig?: Record<string, unknown>;
    cfg?: OpenClawConfig;
}): MemoryLightDreamingConfig & {
    timezone?: string;
    verboseLogging: boolean;
    storage: MemoryDreamingStorageConfig;
};
export declare function resolveMemoryRemDreamingConfig(params: {
    pluginConfig?: Record<string, unknown>;
    cfg?: OpenClawConfig;
}): MemoryRemDreamingConfig & {
    timezone?: string;
    verboseLogging: boolean;
    storage: MemoryDreamingStorageConfig;
};
export declare function formatMemoryDreamingDay(epochMs: number, timezone?: string): string;
export declare function isSameMemoryDreamingDay(firstEpochMs: number, secondEpochMs: number, timezone?: string): boolean;
export declare function resolveMemoryDreamingWorkspaces(cfg: OpenClawConfig, options?: MemoryDreamingWorkspaceOptions): MemoryDreamingWorkspace[];
