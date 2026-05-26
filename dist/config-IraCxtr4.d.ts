import { i as OpenClawConfig, n as ConfigValidationIssue, t as ConfigFileSnapshot } from "./types.openclaw-DIZy8jcb.js";
import { n as PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types-B1XKSJMK.js";
import { m as readConfigFileSnapshotForWrite, r as ConfigWriteOptions } from "./io-BSzQQn6M.js";
import { n as ConfigWriteFollowUp, t as ConfigWriteAfterWrite } from "./runtime-snapshot-BpS1iJ2-.js";
//#region src/config/mutate.d.ts
type ConfigMutationBase = "runtime" | "source";
declare class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;
  constructor(message: string, params: {
    currentHash: string | null;
  });
}
type ConfigReplaceResult = {
  path: string;
  previousHash: string | null;
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  afterWrite: ConfigWriteAfterWrite;
  followUp: ConfigWriteFollowUp;
};
type ConfigMutationIO = {
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<unknown>;
};
declare function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult>;
declare function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  mutate: (draft: OpenClawConfig, context: {
    snapshot: ConfigFileSnapshot;
    previousHash: string | null;
  }) => Promise<T | void> | T | void;
}): Promise<ConfigReplaceResult & {
  result: T | undefined;
}>;
//#endregion
//#region src/config/nix-mode-write-guard.d.ts
declare class NixModeConfigMutationError extends Error {
  readonly code = "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE";
  constructor(params?: {
    configPath?: string;
  });
}
declare function assertConfigWriteAllowedInCurrentMode(params?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): void;
//#endregion
//#region src/config/recovery-policy.d.ts
/**
 * Returns true when an invalid config snapshot is scoped entirely to stale plugin refs.
 */
declare function isPluginLocalInvalidConfigSnapshot(snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">): boolean;
/**
 * Decides whether whole-file last-known-good recovery is safe for a snapshot.
 */
declare function shouldAttemptLastKnownGoodRecovery(snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">): boolean;
//#endregion
//#region src/config/runtime-overrides.d.ts
type OverrideTree = Record<string, unknown>;
declare function getConfigOverrides(): OverrideTree;
declare function resetConfigOverrides(): void;
declare function setConfigOverride(pathRaw: string, value: unknown): {
  ok: boolean;
  error?: string;
};
declare function unsetConfigOverride(pathRaw: string): {
  ok: boolean;
  removed: boolean;
  error?: string;
};
declare function applyConfigOverrides(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
//#region src/config/validation.d.ts
/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
declare function validateConfigObjectRaw(raw: unknown, opts?: {
  sourceRaw?: unknown;
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
  validateBundledChannels?: boolean;
}): {
  ok: true;
  config: OpenClawConfig;
} | {
  ok: false;
  issues: ConfigValidationIssue[];
};
declare function validateConfigObject(raw: unknown, opts?: {
  manifestRegistry?: Pick<PluginMetadataSnapshot, "manifestRegistry">["manifestRegistry"];
  sourceRaw?: unknown;
}): {
  ok: true;
  config: OpenClawConfig;
} | {
  ok: false;
  issues: ConfigValidationIssue[];
};
type ValidateConfigWithPluginsResult = {
  ok: true;
  config: OpenClawConfig;
  warnings: ConfigValidationIssue[];
} | {
  ok: false;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};
type ValidateConfigWithPluginsParams = {
  env?: NodeJS.ProcessEnv;
  pluginValidation?: "full" | "skip";
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
  loadPluginMetadataSnapshot?: (config: OpenClawConfig) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  sourceRaw?: unknown;
};
declare function validateConfigObjectWithPlugins(raw: unknown, params?: ValidateConfigWithPluginsParams): ValidateConfigWithPluginsResult;
declare function validateConfigObjectRawWithPlugins(raw: unknown, params?: ValidateConfigWithPluginsParams): ValidateConfigWithPluginsResult;
//#endregion
export { mutateConfigFile as _, applyConfigOverrides as a, setConfigOverride as c, shouldAttemptLastKnownGoodRecovery as d, NixModeConfigMutationError as f, ConfigReplaceResult as g, ConfigMutationConflictError as h, validateConfigObjectWithPlugins as i, unsetConfigOverride as l, ConfigMutationBase as m, validateConfigObjectRaw as n, getConfigOverrides as o, assertConfigWriteAllowedInCurrentMode as p, validateConfigObjectRawWithPlugins as r, resetConfigOverrides as s, validateConfigObject as t, isPluginLocalInvalidConfigSnapshot as u, replaceConfigFile as v };