import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
export type PluginProviderAuthChoiceOptions = {
    authChoice: string;
    pluginId: string;
    providerId: string;
    methodId?: string;
    label: string;
};
export declare function applyAuthChoicePluginProvider(params: ApplyAuthChoiceParams, options: PluginProviderAuthChoiceOptions): Promise<ApplyAuthChoiceResult | null>;
