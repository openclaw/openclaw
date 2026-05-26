type EnableStateLike = {
    enabled: boolean;
    reason?: string;
};
type PluginKindLike = string | readonly string[] | undefined;
export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";
export type PluginExplicitSelectionCause = "enabled-in-config" | "bundled-channel-enabled-in-config" | "selected-memory-slot" | "selected-context-engine-slot" | "selected-in-allowlist";
export type PluginActivationCause = PluginExplicitSelectionCause | "plugins-disabled" | "blocked-by-denylist" | "disabled-in-config" | "workspace-disabled-by-default" | "not-in-allowlist" | "enabled-by-effective-config" | "bundled-channel-configured" | "bundled-default-enablement" | "bundled-disabled-by-default";
export type PluginActivationStateLike = {
    enabled: boolean;
    activated: boolean;
    explicitlyEnabled: boolean;
    source: PluginActivationSource;
    reason?: string;
};
export type PluginActivationDecision = PluginActivationStateLike & {
    cause?: PluginActivationCause;
};
type PluginActivationConfigLike = {
    enabled: boolean;
    allow: readonly string[];
    deny: readonly string[];
    slots: {
        memory?: string | null;
        contextEngine?: string | null;
    };
    entries: Record<string, {
        enabled?: boolean;
    } | undefined>;
};
export type PluginActivationConfigSourceLike<TRootConfig> = {
    plugins: PluginActivationConfigLike;
    rootConfig?: TRootConfig;
};
export declare const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string>;
export declare function resolvePluginActivationReason(cause?: PluginActivationCause, reason?: string): string | undefined;
export declare function toPluginActivationState(decision: PluginActivationDecision): PluginActivationStateLike;
export declare function resolvePluginActivationDecisionShared<TRootConfig>(params: {
    id: string;
    origin: string;
    config: PluginActivationConfigLike;
    rootConfig?: TRootConfig;
    enabledByDefault?: boolean;
    activationSource?: PluginActivationConfigSourceLike<TRootConfig>;
    autoEnabledReason?: string;
    allowBundledChannelExplicitBypassesAllowlist?: boolean;
    isBundledChannelEnabledByChannelConfig: (rootConfig: TRootConfig | undefined, pluginId: string) => boolean;
}): PluginActivationDecision;
export declare function toEnableStateResult(state: EnableStateLike): {
    enabled: boolean;
    reason?: string;
};
export declare function resolveEnableStateResult<TParams>(params: TParams, resolveState: (params: TParams) => EnableStateLike): {
    enabled: boolean;
    reason?: string;
};
export declare function createPluginEnableStateResolver<TConfig, TOrigin extends string>(resolveState: (params: {
    id: string;
    origin: TOrigin;
    config: TConfig;
    enabledByDefault?: boolean;
}) => EnableStateLike): (id: string, origin: TOrigin, config: TConfig, enabledByDefault?: boolean) => {
    enabled: boolean;
    reason?: string;
};
export declare function createEffectiveEnableStateResolver<TParams>(resolveState: (params: TParams) => EnableStateLike): (params: TParams) => {
    enabled: boolean;
    reason?: string;
};
export declare function resolveMemorySlotDecisionShared(params: {
    id: string;
    kind?: PluginKindLike;
    slot: string | null | undefined;
    selectedId: string | null;
}): {
    enabled: boolean;
    reason?: string;
    selected?: boolean;
};
export {};
