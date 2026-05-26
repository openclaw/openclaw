import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { type CustomApiResult } from "./onboard-custom-config.js";
export { applyCustomApiConfig, buildAnthropicVerificationProbeRequest, buildOpenAiVerificationProbeRequest, CustomApiError, inferCustomModelSupportsImageInput, parseNonInteractiveCustomApiFlags, resolveCustomModelImageInputInference, resolveCustomProviderId, type ApplyCustomApiConfigParams, type CustomApiCompatibility, type CustomApiErrorCode, type CustomModelImageInputInference, type CustomApiResult, type ParseNonInteractiveCustomApiFlagsParams, type ParsedNonInteractiveCustomApiFlags, type ResolveCustomProviderIdParams, type ResolvedCustomProviderId, } from "./onboard-custom-config.js";
import type { SecretInputMode } from "./onboard-types.js";
export declare function promptCustomApiConfig(params: {
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    config: OpenClawConfig;
    secretInputMode?: SecretInputMode;
}): Promise<CustomApiResult>;
