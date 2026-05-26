import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { i as SGLANG_PROVIDER_LABEL, n as SGLANG_DEFAULT_BASE_URL, r as SGLANG_MODEL_PLACEHOLDER, t as SGLANG_DEFAULT_API_KEY_ENV_VAR } from "../../defaults-Qq0RXNMA.js";
import { t as buildSglangProvider } from "../../models-2aqWp33I.js";
import "../../api-B_rZ_zIQ.js";
//#region extensions/sglang/index.ts
const PROVIDER_ID = "sglang";
async function loadProviderSetup() {
	return await import("../../plugin-sdk/provider-setup.js");
}
var sglang_default = definePluginEntry({
	id: "sglang",
	name: "SGLang Provider",
	description: "Bundled SGLang provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "SGLang",
			docsPath: "/providers/sglang",
			envVars: ["SGLANG_API_KEY"],
			auth: [{
				id: "custom",
				label: SGLANG_PROVIDER_LABEL,
				hint: "Fast self-hosted OpenAI-compatible server",
				kind: "custom",
				run: async (ctx) => {
					return await (await loadProviderSetup()).promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
						cfg: ctx.config,
						prompter: ctx.prompter,
						providerId: PROVIDER_ID,
						providerLabel: SGLANG_PROVIDER_LABEL,
						defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
						defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
						modelPlaceholder: SGLANG_MODEL_PLACEHOLDER
					});
				},
				runNonInteractive: async (ctx) => {
					return await (await loadProviderSetup()).configureOpenAICompatibleSelfHostedProviderNonInteractive({
						ctx,
						providerId: PROVIDER_ID,
						providerLabel: SGLANG_PROVIDER_LABEL,
						defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
						defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
						modelPlaceholder: SGLANG_MODEL_PLACEHOLDER
					});
				}
			}],
			catalog: {
				order: "late",
				run: async (ctx) => {
					return await (await loadProviderSetup()).discoverOpenAICompatibleSelfHostedProvider({
						ctx,
						providerId: PROVIDER_ID,
						buildProvider: buildSglangProvider
					});
				}
			},
			wizard: {
				setup: {
					choiceId: "sglang",
					choiceLabel: "SGLang",
					choiceHint: "Fast self-hosted OpenAI-compatible server",
					groupId: "sglang",
					groupLabel: "SGLang",
					groupHint: "Fast self-hosted server",
					methodId: "custom"
				},
				modelPicker: {
					label: "SGLang (custom)",
					hint: "Enter SGLang URL + API key + model",
					methodId: "custom"
				}
			}
		});
	}
});
//#endregion
export { sglang_default as default };
