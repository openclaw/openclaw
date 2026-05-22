import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderConfig } from "./provider-types.js";
export type ResolvedRealtimeVoiceProvider = {
    provider: RealtimeVoiceProviderPlugin;
    providerConfig: RealtimeVoiceProviderConfig;
};
export type ResolveConfiguredRealtimeVoiceProviderParams = {
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
    cfg?: OpenClawConfig;
    cfgForResolve?: OpenClawConfig;
    providers?: RealtimeVoiceProviderPlugin[];
    defaultModel?: string;
    noRegisteredProviderMessage?: string;
};
export declare function resolveConfiguredRealtimeVoiceProvider(params: ResolveConfiguredRealtimeVoiceProviderParams): ResolvedRealtimeVoiceProvider;
