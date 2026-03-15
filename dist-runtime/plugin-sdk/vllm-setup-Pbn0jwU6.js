import { d as VLLM_DEFAULT_BASE_URL, f as VLLM_MODEL_PLACEHOLDER, g as SELF_HOSTED_DEFAULT_MAX_TOKENS, h as SELF_HOSTED_DEFAULT_COST, m as SELF_HOSTED_DEFAULT_CONTEXT_WINDOW, p as VLLM_PROVIDER_LABEL, u as VLLM_DEFAULT_API_KEY_ENV_VAR } from "./paths-BoU0P6Xb.js";
import { i as promptAndConfigureOpenAICompatibleSelfHostedProvider } from "./self-hosted-provider-setup-DGcVewib.js";
//#region src/commands/vllm-setup.ts
const VLLM_DEFAULT_CONTEXT_WINDOW = SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
const VLLM_DEFAULT_MAX_TOKENS = SELF_HOSTED_DEFAULT_MAX_TOKENS;
const VLLM_DEFAULT_COST = SELF_HOSTED_DEFAULT_COST;
async function promptAndConfigureVllm(params) {
	const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider({
		cfg: params.cfg,
		prompter: params.prompter,
		providerId: "vllm",
		providerLabel: VLLM_PROVIDER_LABEL,
		defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
		defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
		modelPlaceholder: VLLM_MODEL_PLACEHOLDER
	});
	return {
		config: result.config,
		modelId: result.modelId,
		modelRef: result.modelRef
	};
}
//#endregion
export { promptAndConfigureVllm as i, VLLM_DEFAULT_COST as n, VLLM_DEFAULT_MAX_TOKENS as r, VLLM_DEFAULT_CONTEXT_WINDOW as t };
