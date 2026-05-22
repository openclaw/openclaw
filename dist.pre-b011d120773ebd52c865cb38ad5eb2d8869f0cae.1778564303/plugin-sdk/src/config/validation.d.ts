import { type PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
export declare function collectUnsupportedSecretRefPolicyIssues(raw: unknown): ConfigValidationIssue[];
declare function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue;
export declare const __testing: {
    mapZodIssueToConfigIssue: typeof mapZodIssueToConfigIssue;
};
/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export declare function validateConfigObjectRaw(raw: unknown, opts?: {
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
export declare function validateConfigObject(raw: unknown, opts?: {
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
export declare function validateConfigObjectWithPlugins(raw: unknown, params?: ValidateConfigWithPluginsParams): ValidateConfigWithPluginsResult;
export declare function validateConfigObjectRawWithPlugins(raw: unknown, params?: ValidateConfigWithPluginsParams): ValidateConfigWithPluginsResult;
export {};
