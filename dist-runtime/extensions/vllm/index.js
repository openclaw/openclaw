import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import { i as VLLM_PROVIDER_LABEL, n as VLLM_DEFAULT_BASE_URL, r as VLLM_MODEL_PLACEHOLDER, t as VLLM_DEFAULT_API_KEY_ENV_VAR } from "../../vllm-defaults-DLfSffbg.js";
//#region extensions/vllm/index.ts
const PROVIDER_ID = "vllm";
async function loadProviderSetup() {
	return await import("../../self-hosted-provider-setup-XwB3ZMXE.js");
}
const vllmPlugin = {
	id: "vllm",
	name: "vLLM Provider",
	description: "Bundled vLLM provider plugin",
	configSchema: emptyPluginConfigSchema(),
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
			discovery: {
				order: "late",
				run: async (ctx) => {
					const providerSetup = await loadProviderSetup();
					return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
						ctx,
						providerId: PROVIDER_ID,
						buildProvider: providerSetup.buildVllmProvider
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
			}
		});
	}
};
//#endregion
export { vllmPlugin as default };
