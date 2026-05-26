import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/memory-host-sdk/dreaming.d.ts
declare const DEFAULT_MEMORY_DREAMING_ENABLED = false;
declare const DEFAULT_MEMORY_DREAMING_TIMEZONE: undefined;
declare const DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING = false;
declare const DEFAULT_MEMORY_DREAMING_STORAGE_MODE = "separate";
declare const DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS = false;
declare const DEFAULT_MEMORY_DREAMING_FREQUENCY = "0 3 * * *";
declare const DEFAULT_MEMORY_DREAMING_PLUGIN_ID = "memory-core";
declare const MANAGED_MEMORY_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
declare const MANAGED_MEMORY_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
declare const MEMORY_DREAMING_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
declare const LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME = "Memory Light Dreaming";
declare const LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
declare const LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
declare const LEGACY_MEMORY_REM_DREAMING_CRON_NAME = "Memory REM Dreaming";
declare const LEGACY_MEMORY_REM_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
declare const LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
declare const DEFAULT_MEMORY_LIGHT_DREAMING_CRON_EXPR = "0 */6 * * *";
declare const DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS = 2;
declare const DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT = 100;
declare const DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY = 0.9;
declare const DEFAULT_MEMORY_DEEP_DREAMING_CRON_EXPR = "0 3 * * *";
declare const DEFAULT_MEMORY_DEEP_DREAMING_LIMIT = 10;
declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE = 0.8;
declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT = 3;
declare const DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES = 3;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
declare const DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS = 30;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_ENABLED = true;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_TRIGGER_BELOW_HEALTH = 0.35;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_LOOKBACK_DAYS = 30;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MAX_CANDIDATES = 20;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MIN_CONFIDENCE = 0.9;
declare const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE = 0.97;
declare const DEFAULT_MEMORY_REM_DREAMING_CRON_EXPR = "0 5 * * 0";
declare const DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS = 7;
declare const DEFAULT_MEMORY_REM_DREAMING_LIMIT = 10;
declare const DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH = 0.75;
declare const DEFAULT_MEMORY_DREAMING_SPEED = "balanced";
declare const DEFAULT_MEMORY_DREAMING_THINKING = "medium";
declare const DEFAULT_MEMORY_DREAMING_BUDGET = "medium";
type MemoryDreamingSpeed = "fast" | "balanced" | "slow";
type MemoryDreamingThinking = "low" | "medium" | "high";
type MemoryDreamingBudget = "cheap" | "medium" | "expensive";
type MemoryDreamingStorageMode = "inline" | "separate" | "both";
type MemoryLightDreamingSource = "daily" | "sessions" | "recall";
type MemoryDeepDreamingSource = "daily" | "memory" | "sessions" | "logs" | "recall";
type MemoryRemDreamingSource = "memory" | "daily" | "deep";
type MemoryDreamingExecutionConfig = {
  speed: MemoryDreamingSpeed;
  thinking: MemoryDreamingThinking;
  budget: MemoryDreamingBudget;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};
type MemoryDreamingStorageConfig = {
  mode: MemoryDreamingStorageMode;
  separateReports: boolean;
};
type MemoryLightDreamingConfig = {
  enabled: boolean;
  cron: string;
  lookbackDays: number;
  limit: number;
  dedupeSimilarity: number;
  sources: MemoryLightDreamingSource[];
  execution: MemoryDreamingExecutionConfig;
};
type MemoryDeepDreamingRecoveryConfig = {
  enabled: boolean;
  triggerBelowHealth: number;
  lookbackDays: number;
  maxRecoveredCandidates: number;
  minRecoveryConfidence: number;
  autoWriteMinConfidence: number;
};
type MemoryDeepDreamingConfig = {
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
type MemoryRemDreamingConfig = {
  enabled: boolean;
  cron: string;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
  sources: MemoryRemDreamingSource[];
  execution: MemoryDreamingExecutionConfig;
};
type MemoryDreamingPhaseName = "light" | "deep" | "rem";
type MemoryDreamingConfig = {
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
type MemoryDreamingWorkspace = {
  workspaceDir: string;
  agentIds: string[];
};
type MemoryDreamingWorkspaceOptions = {
  primaryWorkspaceDir?: string | null;
  primaryAgentId?: string | null;
};
declare function resolveMemoryDreamingPluginId(cfg: OpenClawConfig | Record<string, unknown> | undefined): string;
declare function resolveMemoryDreamingPluginConfig(cfg: OpenClawConfig | Record<string, unknown> | undefined): Record<string, unknown> | undefined;
/** @deprecated Use resolveMemoryDreamingPluginConfig. */
declare const resolveMemoryCorePluginConfig: typeof resolveMemoryDreamingPluginConfig;
declare function resolveMemoryDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryDreamingConfig;
declare function resolveMemoryDeepDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryDeepDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
};
declare function resolveMemoryLightDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryLightDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
};
declare function resolveMemoryRemDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryRemDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
};
declare function formatMemoryDreamingDay(epochMs: number, timezone?: string): string;
declare function isSameMemoryDreamingDay(firstEpochMs: number, secondEpochMs: number, timezone?: string): boolean;
declare function resolveMemoryDreamingWorkspaces(cfg: OpenClawConfig, options?: MemoryDreamingWorkspaceOptions): MemoryDreamingWorkspace[];
//#endregion
export { MemoryDreamingWorkspaceOptions as $, DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS as A, MEMORY_DREAMING_SYSTEM_EVENT_TEXT as B, DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING as C, DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS as D, DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT as E, LEGACY_MEMORY_REM_DREAMING_CRON_NAME as F, MemoryDreamingConfig as G, MemoryDeepDreamingRecoveryConfig as H, LEGACY_MEMORY_REM_DREAMING_CRON_TAG as I, MemoryDreamingSpeed as J, MemoryDreamingExecutionConfig as K, LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT as L, LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME as M, LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG as N, DEFAULT_MEMORY_REM_DREAMING_CRON_EXPR as O, LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT as P, MemoryDreamingWorkspace as Q, MANAGED_MEMORY_DREAMING_CRON_NAME as R, DEFAULT_MEMORY_DREAMING_TIMEZONE as S, DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY as T, MemoryDeepDreamingSource as U, MemoryDeepDreamingConfig as V, MemoryDreamingBudget as W, MemoryDreamingStorageMode as X, MemoryDreamingStorageConfig as Y, MemoryDreamingThinking as Z, DEFAULT_MEMORY_DREAMING_PLUGIN_ID as _, DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE as a, isSameMemoryDreamingDay as at, DEFAULT_MEMORY_DREAMING_STORAGE_MODE as b, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE as c, resolveMemoryDreamingConfig as ct, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MAX_CANDIDATES as d, resolveMemoryDreamingWorkspaces as dt, MemoryLightDreamingConfig as et, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MIN_CONFIDENCE as f, resolveMemoryLightDreamingConfig as ft, DEFAULT_MEMORY_DREAMING_FREQUENCY as g, DEFAULT_MEMORY_DREAMING_ENABLED as h, DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT as i, formatMemoryDreamingDay as it, DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH as j, DEFAULT_MEMORY_REM_DREAMING_LIMIT as k, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_ENABLED as l, resolveMemoryDreamingPluginConfig as lt, DEFAULT_MEMORY_DREAMING_BUDGET as m, DEFAULT_MEMORY_DEEP_DREAMING_LIMIT as n, MemoryRemDreamingConfig as nt, DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES as o, resolveMemoryCorePluginConfig as ot, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_TRIGGER_BELOW_HEALTH as p, resolveMemoryRemDreamingConfig as pt, MemoryDreamingPhaseName as q, DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS as r, MemoryRemDreamingSource as rt, DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS as s, resolveMemoryDeepDreamingConfig as st, DEFAULT_MEMORY_DEEP_DREAMING_CRON_EXPR as t, MemoryLightDreamingSource as tt, DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_LOOKBACK_DAYS as u, resolveMemoryDreamingPluginId as ut, DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS as v, DEFAULT_MEMORY_LIGHT_DREAMING_CRON_EXPR as w, DEFAULT_MEMORY_DREAMING_THINKING as x, DEFAULT_MEMORY_DREAMING_SPEED as y, MANAGED_MEMORY_DREAMING_CRON_TAG as z };