import fs from "node:fs";
import JSON5 from "json5";
import { type PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { clearRuntimeConfigSnapshot as clearRuntimeConfigSnapshotState, getRuntimeConfigSnapshotMetadata as getRuntimeConfigSnapshotMetadataState, getRuntimeConfigSnapshot as getRuntimeConfigSnapshotState, getRuntimeConfigSourceSnapshot as getRuntimeConfigSourceSnapshotState, resetConfigRuntimeState as resetConfigRuntimeStateState, resolveRuntimeConfigCacheKey, selectApplicableRuntimeConfig, setRuntimeConfigSnapshot as setRuntimeConfigSnapshotState, setRuntimeConfigSnapshotRefreshHandler as setRuntimeConfigSnapshotRefreshHandlerState, type ConfigWriteAfterWrite, type RuntimeConfigSnapshotRefreshOptions, type RuntimeConfigWriteNotification } from "./runtime-snapshot.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "./types.js";
export { clearRuntimeConfigSnapshotState as clearRuntimeConfigSnapshot, getRuntimeConfigSnapshotMetadataState as getRuntimeConfigSnapshotMetadata, getRuntimeConfigSnapshotState as getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshotState as getRuntimeConfigSourceSnapshot, resetConfigRuntimeStateState as resetConfigRuntimeState, resolveRuntimeConfigCacheKey, selectApplicableRuntimeConfig, setRuntimeConfigSnapshotState as setRuntimeConfigSnapshot, setRuntimeConfigSnapshotRefreshHandlerState as setRuntimeConfigSnapshotRefreshHandler, };
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";
export { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
export type ParseConfigJson5Result = {
    ok: true;
    parsed: unknown;
} | {
    ok: false;
    error: string;
};
export type ConfigWriteResult = {
    persistedHash: string;
    persistedConfig: OpenClawConfig;
};
export type ConfigWriteOptions = {
    /**
     * Read-time env snapshot used to validate `${VAR}` restoration decisions.
     * If omitted, write falls back to current process env.
     */
    envSnapshotForRestore?: Record<string, string | undefined>;
    /**
     * Optional safety check: only use envSnapshotForRestore when writing the
     * same config file path that produced the snapshot.
     */
    expectedConfigPath?: string;
    /**
     * Paths that must be explicitly removed from the persisted file payload,
     * even if schema/default normalization reintroduces them.
     */
    unsetPaths?: string[][];
    /**
     * Paths that were explicitly set by the caller. Values at these paths are
     * persisted even when they equal runtime-injected defaults.
     */
    explicitSetPaths?: readonly (readonly string[])[];
    /**
     * Internal companion for explicitSetPaths after a wrapper has projected a
     * runtime-shaped config back onto the authored source shape.
     */
    explicitSetValueSource?: OpenClawConfig;
    /**
     * Internal fast path for callers that already hold a fresh config snapshot.
     * Avoids rereading the full config just to prepare an immediate write.
     */
    baseSnapshot?: ConfigFileSnapshot;
    /**
     * Internal one-shot CLI fast path. When no runtime snapshot is active, skip
     * the post-write runtime snapshot refresh/reload tail entirely.
     */
    skipRuntimeSnapshotRefresh?: boolean;
    /**
     * Optional controls for the active runtime snapshot refresh after this write.
     */
    runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
    /**
     * Allow intentionally destructive config writes, such as explicit reset flows.
     * Normal writers must keep this false so clobbers are rejected before disk commit.
     */
    allowDestructiveWrite?: boolean;
    /**
     * Allow an intentional large config size drop while keeping other destructive
     * guards active. Used by repair flows that remove stale or legacy config.
     */
    allowConfigSizeDrop?: boolean;
    /**
     * Suppress human-readable output logs (overwrite/anomaly messages).
     * Useful when the caller wants machine-readable output only (--json mode).
     */
    skipOutputLogs?: boolean;
    /**
     * Runtime reload intent for observers that react to committed config writes.
     * Omitted means the observer should use its normal reload plan.
     */
    afterWrite?: ConfigWriteAfterWrite;
    /**
     * Legacy root keys to preserve on disk while excluding them from write validation.
     * This is for doctor repair of historical config metadata that should not become
     * part of the public schema contract again.
     */
    preservedLegacyRootKeys?: readonly string[];
    /**
     * Skip plugin-aware validation before writing. Use only for safe partial
     * migrations (e.g. legacy key removal) where the base schema is valid but
     * an unrelated plugin rule prevents the full write from succeeding.
     */
    skipPluginValidation?: boolean;
    /**
     * Preserve an older writer version for update handoff writes that must be
     * readable by the parent process after a candidate doctor repair.
     */
    lastTouchedVersionOverride?: string;
};
export type ReadConfigFileSnapshotForWriteResult = {
    snapshot: ConfigFileSnapshot;
    writeOptions: ConfigWriteOptions;
};
export type ConfigWriteNotification = RuntimeConfigWriteNotification;
export type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
export declare class ConfigRuntimeRefreshError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function resolveConfigSnapshotHash(snapshot: {
    hash?: string;
    raw?: string | null;
}): string | null;
export type ConfigIoDeps = {
    fs?: typeof fs;
    json5?: typeof JSON5;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    configPath?: string;
    logger?: Pick<typeof console, "error" | "warn">;
    measure?: ConfigSnapshotReadMeasure;
    suppressFutureVersionWarning?: boolean;
    observe?: boolean;
};
export type ConfigSnapshotReadOptions = {
    measure?: ConfigSnapshotReadMeasure;
    observe?: boolean;
    skipPluginValidation?: boolean;
    preservedLegacyRootKeys?: readonly string[];
};
export declare function parseConfigJson5(raw: string, json5?: {
    parse: (value: string) => unknown;
}): ParseConfigJson5Result;
export type ReadConfigFileSnapshotWithPluginMetadataResult = {
    snapshot: ConfigFileSnapshot;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
};
export declare function createConfigIO(overrides?: ConfigIoDeps & {
    pluginValidation?: "full" | "skip";
    preservedLegacyRootKeys?: readonly string[];
}): {
    configPath: string;
    loadConfig: () => OpenClawConfig;
    readBestEffortConfig: () => Promise<OpenClawConfig>;
    readSourceConfigBestEffort: () => Promise<OpenClawConfig>;
    readConfigFileSnapshot: () => Promise<ConfigFileSnapshot>;
    readConfigFileSnapshotWithPluginMetadata: () => Promise<ReadConfigFileSnapshotWithPluginMetadataResult>;
    readConfigFileSnapshotForWrite: () => Promise<ReadConfigFileSnapshotForWriteResult>;
    promoteConfigSnapshotToLastKnownGood: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
    recoverConfigFromLastKnownGood: (params: {
        snapshot: ConfigFileSnapshot;
        reason: string;
    }) => Promise<boolean>;
    recoverConfigFromJsonRootSuffix: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
    writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<{
        persistedHash: string;
        persistedConfig: OpenClawConfig;
    }>;
};
export declare function clearConfigCache(): void;
export declare function registerConfigWriteListener(listener: (event: ConfigWriteNotification) => void): () => void;
export declare function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig;
export declare function loadConfig(options?: {
    skipPluginValidation?: boolean;
}): OpenClawConfig;
export declare function getRuntimeConfig(options?: {
    skipPluginValidation?: boolean;
}): OpenClawConfig;
export declare function readBestEffortConfig(): Promise<OpenClawConfig>;
export declare function readSourceConfigBestEffort(): Promise<OpenClawConfig>;
export declare function readConfigFileSnapshot(options?: ConfigSnapshotReadOptions): Promise<ConfigFileSnapshot>;
export declare function readConfigFileSnapshotWithPluginMetadata(options?: {
    measure?: ConfigSnapshotReadMeasure;
}): Promise<ReadConfigFileSnapshotWithPluginMetadataResult>;
export declare function promoteConfigSnapshotToLastKnownGood(snapshot: ConfigFileSnapshot): Promise<boolean>;
export declare function recoverConfigFromLastKnownGood(params: {
    snapshot: ConfigFileSnapshot;
    reason: string;
}): Promise<boolean>;
export declare function recoverConfigFromJsonRootSuffix(snapshot: ConfigFileSnapshot): Promise<boolean>;
export declare function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot>;
export declare function readConfigFileSnapshotForWrite(options?: {
    skipPluginValidation?: boolean;
}): Promise<ReadConfigFileSnapshotForWriteResult>;
export declare function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult>;
export declare function writeConfigFile(cfg: OpenClawConfig, options?: ConfigWriteOptions): Promise<ConfigWriteResult>;
