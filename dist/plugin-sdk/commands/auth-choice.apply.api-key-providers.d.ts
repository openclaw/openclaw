import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import type { AuthChoice, SecretInputMode } from "./onboard-types.js";
type ApiKeyProviderConfigApplier = (config: ApplyAuthChoiceParams["config"]) => ApplyAuthChoiceParams["config"];
type ApplyProviderDefaultModel = (args: {
    defaultModel: string;
    applyDefaultConfig: ApiKeyProviderConfigApplier;
    applyProviderConfig: ApiKeyProviderConfigApplier;
    noteDefault?: string;
}) => Promise<void>;
type ApplyApiKeyProviderParams = {
    params: ApplyAuthChoiceParams;
    authChoice: AuthChoice;
    config: ApplyAuthChoiceParams["config"];
    setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
    getConfig: () => ApplyAuthChoiceParams["config"];
    normalizedTokenProvider?: string;
    requestedSecretInputMode?: SecretInputMode;
    applyProviderDefaultModel: ApplyProviderDefaultModel;
    getAgentModelOverride: () => string | undefined;
};
export declare function applyLiteLlmApiKeyProvider({ params, authChoice, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride, }: ApplyApiKeyProviderParams): Promise<ApplyAuthChoiceResult | null>;
export declare function applySimpleAuthChoiceApiProvider({ params, authChoice, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride, }: ApplyApiKeyProviderParams): Promise<ApplyAuthChoiceResult | null>;
export {};
