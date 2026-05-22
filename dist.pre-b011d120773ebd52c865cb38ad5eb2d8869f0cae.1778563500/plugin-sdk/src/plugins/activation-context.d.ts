import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type NormalizedPluginsConfig, type PluginActivationConfigSource } from "./config-state.js";
export type PluginActivationCompatConfig = {
    allowlistPluginIds?: readonly string[];
    enablementPluginIds?: readonly string[];
    vitestPluginIds?: readonly string[];
};
export type PluginActivationBundledCompatMode = {
    allowlist?: boolean;
    enablement?: "always" | "allowlist";
    vitest?: boolean;
};
export type PluginActivationInputs = {
    rawConfig?: OpenClawConfig;
    config?: OpenClawConfig;
    normalized: NormalizedPluginsConfig;
    activationSourceConfig?: OpenClawConfig;
    activationSource: PluginActivationConfigSource;
    autoEnabledReasons: Record<string, string[]>;
};
export type PluginActivationSnapshot = Pick<PluginActivationInputs, "rawConfig" | "config" | "normalized" | "activationSourceConfig" | "activationSource" | "autoEnabledReasons">;
export type BundledPluginCompatibleActivationInputs = PluginActivationInputs & {
    compatPluginIds: string[];
};
export type BundledPluginCompatibleLoadValues = Pick<BundledPluginCompatibleActivationInputs, "rawConfig" | "config" | "activationSourceConfig" | "autoEnabledReasons" | "compatPluginIds">;
type BundledPluginCompatibleActivationParams = {
    rawConfig?: OpenClawConfig;
    resolvedConfig?: OpenClawConfig;
    autoEnabledReasons?: Record<string, string[]>;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    onlyPluginIds?: readonly string[];
    applyAutoEnable?: boolean;
    compatMode: PluginActivationBundledCompatMode;
    resolveCompatPluginIds: (params: {
        config?: OpenClawConfig;
        workspaceDir?: string;
        env?: NodeJS.ProcessEnv;
        onlyPluginIds?: readonly string[];
    }) => string[];
};
export declare function withActivatedPluginIds(params: {
    config?: OpenClawConfig;
    pluginIds: readonly string[];
    overrideGlobalDisable?: boolean;
    overrideExplicitDisable?: boolean;
}): OpenClawConfig | undefined;
export declare function applyPluginCompatibilityOverrides(params: {
    config?: OpenClawConfig;
    compat?: PluginActivationCompatConfig;
    env: NodeJS.ProcessEnv;
}): OpenClawConfig | undefined;
export declare function resolvePluginActivationSnapshot(params: {
    rawConfig?: OpenClawConfig;
    resolvedConfig?: OpenClawConfig;
    autoEnabledReasons?: Record<string, string[]>;
    env?: NodeJS.ProcessEnv;
    applyAutoEnable?: boolean;
}): PluginActivationSnapshot;
export declare function resolvePluginActivationInputs(params: {
    rawConfig?: OpenClawConfig;
    resolvedConfig?: OpenClawConfig;
    autoEnabledReasons?: Record<string, string[]>;
    env?: NodeJS.ProcessEnv;
    compat?: PluginActivationCompatConfig;
    applyAutoEnable?: boolean;
}): PluginActivationInputs;
export declare function resolveBundledPluginCompatibleActivationInputs(params: BundledPluginCompatibleActivationParams): BundledPluginCompatibleActivationInputs;
export declare function resolveBundledPluginCompatibleLoadValues(params: BundledPluginCompatibleActivationParams): BundledPluginCompatibleLoadValues;
export {};
