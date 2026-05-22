import type { ModelApi } from "../provider-onboard.js";
import type { OpenClawConfig } from "../testing.js";
import { createLegacyProviderConfig } from "./onboard-config.js";
export declare function expectProviderOnboardAllowlistAlias(params: {
    applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
    modelRef: string;
    alias: string;
}): void;
export declare function expectProviderOnboardPrimaryAndFallbacks(params: {
    applyConfig: (config: OpenClawConfig) => OpenClawConfig;
    modelRef: string;
}): void;
export declare function expectProviderOnboardPrimaryModel(params: {
    applyConfig: (config: OpenClawConfig) => OpenClawConfig;
    modelRef: string;
}): void;
export declare function expectProviderOnboardPreservesPrimary(params: {
    applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
    primaryModelRef: string;
}): void;
export declare function expectProviderOnboardMergedLegacyConfig(params: {
    applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
    providerId: string;
    providerApi: ModelApi;
    baseUrl: string;
    legacyApi: Parameters<typeof createLegacyProviderConfig>[0]["api"];
    legacyModelId?: string;
    legacyModelName?: string;
    legacyBaseUrl?: string;
    legacyApiKey?: string;
}): import("../provider-onboard.js").ModelProviderConfig | undefined;
