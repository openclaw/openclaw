import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginActivationConfigSourceLike, type PluginActivationSource, type PluginActivationStateLike } from "./config-activation-shared.js";
import { isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared, type NormalizedPluginsConfig as SharedNormalizedPluginsConfig } from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type { PluginActivationSource };
export type PluginActivationState = PluginActivationStateLike;
export type PluginActivationConfigSource = {
    plugins: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
} & PluginActivationConfigSourceLike<OpenClawConfig>;
export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;
export declare function normalizePluginId(id: string): string;
export declare const normalizePluginsConfig: (config?: OpenClawConfig["plugins"]) => NormalizedPluginsConfig;
export declare function createPluginActivationSource(params: {
    config?: OpenClawConfig;
    plugins?: NormalizedPluginsConfig;
}): PluginActivationConfigSource;
export declare const hasExplicitPluginConfig: (plugins?: OpenClawConfig["plugins"]) => boolean;
export declare function applyTestPluginDefaults(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): OpenClawConfig;
export declare function isTestDefaultMemorySlotDisabled(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
export declare function resolvePluginActivationState(params: {
    id: string;
    origin: PluginOrigin;
    config: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
    enabledByDefault?: boolean;
    activationSource?: PluginActivationConfigSource;
    autoEnabledReason?: string;
}): PluginActivationState;
export declare const resolveEnableState: (id: string, origin: PluginOrigin, config: SharedNormalizedPluginsConfig, enabledByDefault?: boolean) => {
    enabled: boolean;
    reason?: string;
};
export declare const isBundledChannelEnabledByChannelConfig: typeof isBundledChannelEnabledByChannelConfigShared;
type EffectiveActivationParams = {
    id: string;
    origin: PluginOrigin;
    config: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
    enabledByDefault?: boolean;
    activationSource?: PluginActivationConfigSource;
};
export declare const resolveEffectiveEnableState: (params: EffectiveActivationParams) => {
    enabled: boolean;
    reason?: string;
};
export declare function resolveEffectivePluginActivationState(params: {
    id: EffectiveActivationParams["id"];
    origin: EffectiveActivationParams["origin"];
    config: EffectiveActivationParams["config"];
    rootConfig?: EffectiveActivationParams["rootConfig"];
    enabledByDefault?: EffectiveActivationParams["enabledByDefault"];
    activationSource?: EffectiveActivationParams["activationSource"];
    autoEnabledReason?: string;
}): PluginActivationState;
export declare function resolveMemorySlotDecision(params: {
    id: string;
    kind?: string | string[];
    slot: string | null | undefined;
    selectedId: string | null;
}): {
    enabled: boolean;
    reason?: string;
    selected?: boolean;
};
