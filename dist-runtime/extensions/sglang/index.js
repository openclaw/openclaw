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
import { i as SGLANG_PROVIDER_LABEL, n as SGLANG_DEFAULT_BASE_URL, r as SGLANG_MODEL_PLACEHOLDER, t as SGLANG_DEFAULT_API_KEY_ENV_VAR } from "../../sglang-defaults-CzghSv6A.js";
//#region extensions/sglang/index.ts
const PROVIDER_ID = "sglang";
async function loadProviderSetup() {
	return await import("../../self-hosted-provider-setup-XwB3ZMXE.js");
}
const sglangPlugin = {
	id: "sglang",
	name: "SGLang Provider",
	description: "Bundled SGLang provider plugin",
	configSchema: emptyPluginConfigSchema(),
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
			discovery: {
				order: "late",
				run: async (ctx) => {
					const providerSetup = await loadProviderSetup();
					return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
						ctx,
						providerId: PROVIDER_ID,
						buildProvider: providerSetup.buildSglangProvider
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
};
//#endregion
export { sglangPlugin as default };
