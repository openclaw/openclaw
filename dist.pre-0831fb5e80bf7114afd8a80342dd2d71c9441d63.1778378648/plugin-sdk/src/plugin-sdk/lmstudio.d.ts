import type { OpenClawConfig } from "../config/types.js";
import type { ProviderAuthMethodNonInteractiveContext, ProviderAuthResult, ProviderCatalogContext, ProviderPrepareDynamicModelContext, ProviderRuntimeModel } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type { OpenClawPluginApi, ProviderAuthContext, ProviderAuthMethodNonInteractiveContext, ProviderAuthResult, ProviderCatalogContext, ProviderDiscoveryContext, ProviderPrepareDynamicModelContext, ProviderRuntimeModel, } from "../plugins/types.js";
export type { LmstudioModelBase, LmstudioModelWire } from "./lmstudio-runtime.js";
export { LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, LMSTUDIO_DEFAULT_MODEL_ID, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_MODEL_PLACEHOLDER, LMSTUDIO_PROVIDER_ID, LMSTUDIO_PROVIDER_LABEL, buildLmstudioAuthHeaders, discoverLmstudioModels, ensureLmstudioModelLoaded, fetchLmstudioModels, mapLmstudioWireEntry, normalizeLmstudioProviderConfig, resolveLoadedContextWindow, resolveLmstudioConfiguredApiKey, resolveLmstudioInferenceBase, resolveLmstudioProviderHeaders, resolveLmstudioReasoningCapability, resolveLmstudioRuntimeApiKey, resolveLmstudioServerBase, } from "./lmstudio-runtime.js";
type LmstudioInteractiveParams = {
    config: OpenClawConfig;
    prompter?: WizardPrompter;
    secretInputMode?: unknown;
    allowSecretRefPrompt?: boolean;
    promptText?: (params: {
        message: string;
        initialValue?: string;
        placeholder?: string;
        validate?: (value: string | undefined) => string | undefined;
    }) => Promise<string | undefined>;
    note?: (message: string, title?: string) => Promise<void> | void;
};
type FacadeModule = {
    promptAndConfigureLmstudioInteractive: (params: LmstudioInteractiveParams) => Promise<ProviderAuthResult>;
    configureLmstudioNonInteractive: (ctx: ProviderAuthMethodNonInteractiveContext) => Promise<OpenClawConfig | null>;
    discoverLmstudioProvider: (ctx: ProviderCatalogContext) => Promise<{
        provider: import("../config/types.js").ModelProviderConfig;
    } | null>;
    prepareLmstudioDynamicModels: (ctx: ProviderPrepareDynamicModelContext) => Promise<ProviderRuntimeModel[]>;
};
export declare const promptAndConfigureLmstudioInteractive: FacadeModule["promptAndConfigureLmstudioInteractive"];
export declare const configureLmstudioNonInteractive: FacadeModule["configureLmstudioNonInteractive"];
export declare const discoverLmstudioProvider: FacadeModule["discoverLmstudioProvider"];
export declare const prepareLmstudioDynamicModels: FacadeModule["prepareLmstudioDynamicModels"];
