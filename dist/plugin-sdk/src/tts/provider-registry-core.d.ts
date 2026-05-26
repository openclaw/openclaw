import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechProviderId } from "./provider-types.js";
export type SpeechProviderRegistryResolver = {
    getProvider: (providerId: string, cfg?: OpenClawConfig) => SpeechProviderPlugin | undefined;
    listProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
};
export declare function normalizeSpeechProviderId(providerId: string | undefined): SpeechProviderId | undefined;
export declare function createSpeechProviderRegistry(resolver: SpeechProviderRegistryResolver): {
    canonicalizeSpeechProviderId: (providerId: string | undefined, cfg?: OpenClawConfig) => SpeechProviderId | undefined;
    getSpeechProvider: (providerId: string | undefined, cfg?: OpenClawConfig) => SpeechProviderPlugin | undefined;
    listSpeechProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
};
