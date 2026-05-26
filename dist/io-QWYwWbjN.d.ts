import { i as OpenClawConfig, t as ConfigFileSnapshot } from "./types.openclaw-BLF4DJTX.js";
import { n as PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types-CemL6rws.js";
import { a as RuntimeConfigWriteNotification, i as RuntimeConfigSnapshotRefreshOptions, t as ConfigWriteAfterWrite } from "./runtime-snapshot-DFYNlVNW.js";
import fs from "node:fs";
import JSON5 from "json5";

//#region src/config/io.d.ts
type ParseConfigJson5Result = {
  ok: true;
  parsed: unknown;
} | {
  ok: false;
  error: string;
};
type ConfigWriteResult = {
  persistedHash: string;
  persistedConfig: OpenClawConfig;
};
type ConfigWriteOptions = {
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
type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};
type ConfigWriteNotification = RuntimeConfigWriteNotification;
type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
declare class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: {
    cause?: unknown;
  });
}
declare function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null;
type ConfigIoDeps = {
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
type ConfigSnapshotReadOptions = {
  measure?: ConfigSnapshotReadMeasure;
  observe?: boolean;
  skipPluginValidation?: boolean;
  preservedLegacyRootKeys?: readonly string[];
};
declare function parseConfigJson5(raw: string, json5?: {
  parse: (value: string) => unknown;
}): ParseConfigJson5Result;
type ReadConfigFileSnapshotWithPluginMetadataResult = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};
declare function createConfigIO(overrides?: ConfigIoDeps & {
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
declare function clearConfigCache(): void;
declare function registerConfigWriteListener(listener: (event: ConfigWriteNotification) => void): () => void;
declare function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig;
declare function loadConfig(options?: {
  skipPluginValidation?: boolean;
}): OpenClawConfig;
declare function getRuntimeConfig(options?: {
  skipPluginValidation?: boolean;
}): OpenClawConfig;
declare function readBestEffortConfig(): Promise<OpenClawConfig>;
declare function readSourceConfigBestEffort(): Promise<OpenClawConfig>;
declare function readConfigFileSnapshot(options?: ConfigSnapshotReadOptions): Promise<ConfigFileSnapshot>;
declare function readConfigFileSnapshotWithPluginMetadata(options?: {
  measure?: ConfigSnapshotReadMeasure;
}): Promise<ReadConfigFileSnapshotWithPluginMetadataResult>;
declare function promoteConfigSnapshotToLastKnownGood(snapshot: ConfigFileSnapshot): Promise<boolean>;
declare function recoverConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean>;
declare function recoverConfigFromJsonRootSuffix(snapshot: ConfigFileSnapshot): Promise<boolean>;
declare function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot>;
declare function readConfigFileSnapshotForWrite(options?: {
  skipPluginValidation?: boolean;
}): Promise<ReadConfigFileSnapshotForWriteResult>;
declare function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult>;
declare function writeConfigFile(cfg: OpenClawConfig, options?: ConfigWriteOptions): Promise<ConfigWriteResult>;
//#endregion
export { registerConfigWriteListener as C, recoverConfigFromLastKnownGood as S, writeConfigFile as T, readConfigFileSnapshotWithPluginMetadata as _, ConfigWriteResult as a, readSourceConfigSnapshotForWrite as b, createConfigIO as c, parseConfigJson5 as d, projectConfigOntoRuntimeSourceSnapshot as f, readConfigFileSnapshotForWrite as g, readConfigFileSnapshot as h, ConfigWriteOptions as i, getRuntimeConfig as l, readBestEffortConfig as m, ConfigSnapshotReadOptions as n, ReadConfigFileSnapshotWithPluginMetadataResult as o, promoteConfigSnapshotToLastKnownGood as p, ConfigWriteNotification as r, clearConfigCache as s, ConfigRuntimeRefreshError as t, loadConfig as u, readSourceConfigBestEffort as v, resolveConfigSnapshotHash as w, recoverConfigFromJsonRootSuffix as x, readSourceConfigSnapshot as y };