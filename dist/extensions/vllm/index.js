import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { i as VLLM_PROVIDER_LABEL, n as VLLM_DEFAULT_BASE_URL, r as VLLM_MODEL_PLACEHOLDER, t as VLLM_DEFAULT_API_KEY_ENV_VAR } from "../../defaults-Cha6Xv-5.js";
import { t as buildVllmProvider } from "../../models-C_NyT8MT.js";
import { r as wrapVllmProviderStream } from "../../stream-BabfpIl2.js";
import "../../api-YxXhUv-j.js";
//#region extensions/vllm/index.ts
const PROVIDER_ID = "vllm";
async function loadProviderSetup() {
	return await import("../../plugin-sdk/provider-setup.js");
}
var vllm_default = definePluginEntry({
	id: "vllm",
	name: "vLLM Provider",
	description: "Bundled vLLM provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "vLLM",
			docsPath: "/providers/vllm",
			envVars: ["VLLM_API_KEY"],
			auth: [{
				id: "custom",
				label: VLLM_PROVIDER_LABEL,
				hint: "Local/self-hosted OpenAI-compatible server",
				kind: "custom",
				run: async (ctx) => {
					return await (await loadProviderSetup()).promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
						cfg: ctx.config,
						prompter: ctx.prompter,
						providerId: PROVIDER_ID,
						providerLabel: VLLM_PROVIDER_LABEL,
						defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
						defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
						modelPlaceholder: VLLM_MODEL_PLACEHOLDER
					});
				},
				runNonInteractive: async (ctx) => {
					return await (await loadProviderSetup()).configureOpenAICompatibleSelfHostedProviderNonInteractive({
						ctx,
						providerId: PROVIDER_ID,
						providerLabel: VLLM_PROVIDER_LABEL,
						defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
						defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
						modelPlaceholder: VLLM_MODEL_PLACEHOLDER
					});
				}
			}],
			catalog: {
				order: "late",
				run: async (ctx) => {
					return await (await loadProviderSetup()).discoverOpenAICompatibleSelfHostedProvider({
						ctx,
						providerId: PROVIDER_ID,
						buildProvider: buildVllmProvider
					});
				}
			},
			wizard: {
				setup: {
					choiceId: "vllm",
					choiceLabel: "vLLM",
					choiceHint: "Local/self-hosted OpenAI-compatible server",
					groupId: "vllm",
					groupLabel: "vLLM",
					groupHint: "Local/self-hosted OpenAI-compatible",
					methodId: "custom"
				},
				modelPicker: {
					label: "vLLM (custom)",
					hint: "Enter vLLM URL + API key + model",
					methodId: "custom"
				}
			},
			buildUnknownModelHint: () => "vLLM requires authentication to be registered as a provider. Set VLLM_API_KEY (any value works) or run \"openclaw configure\". See: https://docs.openclaw.ai/providers/vllm",
			wrapStreamFn: wrapVllmProviderStream
		});
	}
});
//#endregion
export { vllm_default as default };
