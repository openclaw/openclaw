import type { OpenClawConfig } from "../config/config.js";
import { KILOCODE_BASE_URL } from "../providers/kilocode-shared.js";
export { applyCloudflareAiGatewayConfig, applyCloudflareAiGatewayProviderConfig, applyVercelAiGatewayConfig, applyVercelAiGatewayProviderConfig, } from "./onboard-auth.config-gateways.js";
export { applyLitellmConfig, applyLitellmProviderConfig, LITELLM_BASE_URL, LITELLM_DEFAULT_MODEL_ID, } from "./onboard-auth.config-litellm.js";
export declare function applyZaiProviderConfig(cfg: OpenClawConfig, params?: {
    endpoint?: string;
    modelId?: string;
}): OpenClawConfig;
export declare function applyZaiConfig(cfg: OpenClawConfig, params?: {
    endpoint?: string;
    modelId?: string;
}): OpenClawConfig;
export declare function applyOpenrouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyOpenrouterConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMoonshotProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMoonshotProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMoonshotConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMoonshotConfigCn(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applySyntheticProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applySyntheticConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyXiaomiProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyXiaomiConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Venice provider configuration without changing the default model.
 * Registers Venice models and sets up the provider, but preserves existing model selection.
 */
export declare function applyVeniceProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Venice provider configuration AND set Venice as the default model.
 * Use this when Venice is the primary provider choice during onboarding.
 */
export declare function applyVeniceConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Together provider configuration without changing the default model.
 * Registers Together models and sets up the provider, but preserves existing model selection.
 */
export declare function applyTogetherProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Together provider configuration AND set Together as the default model.
 * Use this when Together is the primary provider choice during onboarding.
 */
export declare function applyTogetherConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Hugging Face (Inference Providers) provider configuration without changing the default model.
 */
export declare function applyHuggingfaceProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Hugging Face provider configuration AND set Hugging Face as the default model.
 */
export declare function applyHuggingfaceConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyXaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMistralProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMistralConfig(cfg: OpenClawConfig): OpenClawConfig;
export { KILOCODE_BASE_URL };
/**
 * Apply Kilo Gateway provider configuration without changing the default model.
 * Registers Kilo Gateway and sets up the provider, but preserves existing model selection.
 */
export declare function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Kilo Gateway provider configuration AND set Kilo Gateway as the default model.
 * Use this when Kilo Gateway is the primary provider choice during onboarding.
 */
export declare function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyAuthProfileConfig(cfg: OpenClawConfig, params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    preferProfileFirst?: boolean;
}): OpenClawConfig;
export declare function applyQianfanProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyQianfanConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyModelStudioProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyModelStudioProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyModelStudioConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyModelStudioConfigCn(cfg: OpenClawConfig): OpenClawConfig;
