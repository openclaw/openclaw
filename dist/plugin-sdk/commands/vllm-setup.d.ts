import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyProviderDefaultModel } from "./self-hosted-provider-setup.js";
export declare const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export declare const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
export declare const VLLM_DEFAULT_MAX_TOKENS = 8192;
export declare const VLLM_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
export declare function promptAndConfigureVllm(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
}): Promise<{
    config: OpenClawConfig;
    modelId: string;
    modelRef: string;
}>;
export { applyProviderDefaultModel as applyVllmDefaultModel };
