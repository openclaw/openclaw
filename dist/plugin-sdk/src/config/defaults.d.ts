import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { OpenClawConfig } from "./types.openclaw.js";
type WarnState = {
    warned: boolean;
};
type ProviderPolicyDefaultsOptions = {
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};
export declare function resolveNormalizedProviderModelMaxTokens(params: {
    providerId: string;
    modelId: string;
    contextWindow: number;
    rawMaxTokens: number;
}): number;
type SessionDefaultsOptions = {
    warn?: (message: string) => void;
    warnState?: WarnState;
};
export declare function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applySessionDefaults(cfg: OpenClawConfig, options?: SessionDefaultsOptions): OpenClawConfig;
export declare function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig;
export declare function applyModelDefaults(cfg: OpenClawConfig, options?: ProviderPolicyDefaultsOptions): OpenClawConfig;
export declare function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyContextPruningDefaults(cfg: OpenClawConfig, options?: ProviderPolicyDefaultsOptions): OpenClawConfig;
export declare function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig;
export {};
