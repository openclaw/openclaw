import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { type WizardPrompter } from "../wizard/prompts.js";
import type { OnboardOptions } from "./onboard-types.js";
export { OLLAMA_DEFAULT_BASE_URL } from "../agents/ollama-models.js";
export declare const OLLAMA_DEFAULT_MODEL = "glm-4.7-flash";
/**
 * Interactive: prompt for base URL, discover models, configure provider.
 * Model selection is handled by the standard model picker downstream.
 */
export declare function promptAndConfigureOllama(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
}): Promise<{
    config: OpenClawConfig;
    defaultModelId: string;
}>;
/** Non-interactive: auto-discover models and configure provider. */
export declare function configureOllamaNonInteractive(params: {
    nextConfig: OpenClawConfig;
    opts: OnboardOptions;
    runtime: RuntimeEnv;
}): Promise<OpenClawConfig>;
/** Pull the configured default Ollama model if it isn't already available locally. */
export declare function ensureOllamaModelPulled(params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
}): Promise<void>;
