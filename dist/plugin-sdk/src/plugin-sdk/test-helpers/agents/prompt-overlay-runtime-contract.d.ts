import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderSystemPromptContributionContext } from "../../../plugins/types.js";
export declare const GPT5_CONTRACT_MODEL_ID = "gpt-5.4";
export declare const GPT5_PREFIXED_CONTRACT_MODEL_ID = "openai/gpt-5.4";
export declare const NON_GPT5_CONTRACT_MODEL_ID = "gpt-4.1";
export declare const OPENAI_CONTRACT_PROVIDER_ID = "openai";
export declare const OPENAI_CODEX_CONTRACT_PROVIDER_ID = "openai-codex";
export declare const CODEX_CONTRACT_PROVIDER_ID = "codex";
export declare const NON_OPENAI_CONTRACT_PROVIDER_ID = "openrouter";
export declare function openAiPluginPersonalityConfig(personality: "friendly" | "off"): OpenClawConfig;
export declare function sharedGpt5PersonalityConfig(personality: "friendly" | "off"): OpenClawConfig;
export declare function codexPromptOverlayContext(params?: {
    modelId?: string;
    config?: OpenClawConfig;
}): ProviderSystemPromptContributionContext;
