import {
	definePluginEntry,
	type OpenClawPluginApi,
	type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
	buildLocalaiProvider,
	LOCALAI_DEFAULT_API_KEY_ENV_VAR,
	LOCALAI_DEFAULT_BASE_URL,
	LOCALAI_MODEL_PLACEHOLDER,
	LOCALAI_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "localai";

async function loadProviderSetup() {
	return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
	id: "localai",
	name: "LocalAI Provider",
	description: "Bundled LocalAI provider plugin",
	register(api: OpenClawPluginApi) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "LocalAI",
			docsPath: "/providers/localai",
			envVars: ["LOCALAI_API_KEY"],
			auth: [
				{
					id: "custom",
					label: LOCALAI_PROVIDER_LABEL,
					hint: "Multimodal, scalable local inference with auth",
					kind: "custom",
					run: async (ctx) => {
						const providerSetup = await loadProviderSetup();
						return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
							cfg: ctx.config,
							prompter: ctx.prompter,
							providerId: PROVIDER_ID,
							providerLabel: LOCALAI_PROVIDER_LABEL,
							defaultBaseUrl: LOCALAI_DEFAULT_BASE_URL,
							defaultApiKeyEnvVar: LOCALAI_DEFAULT_API_KEY_ENV_VAR,
							modelPlaceholder: LOCALAI_MODEL_PLACEHOLDER,
						});
					},
					runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
						const providerSetup = await loadProviderSetup();
						return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
							ctx,
							providerId: PROVIDER_ID,
							providerLabel: LOCALAI_PROVIDER_LABEL,
							defaultBaseUrl: LOCALAI_DEFAULT_BASE_URL,
							defaultApiKeyEnvVar: LOCALAI_DEFAULT_API_KEY_ENV_VAR,
							modelPlaceholder: LOCALAI_MODEL_PLACEHOLDER,
						});
					},
				},
			],
			discovery: {
				order: "late",
				run: async (ctx) => {
					const providerSetup = await loadProviderSetup();
					return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
						ctx,
						providerId: PROVIDER_ID,
						buildProvider: buildLocalaiProvider,
					});
				},
			},
			wizard: {
				setup: {
					choiceId: "localai",
					choiceLabel: "LocalAI",
					choiceHint: "Multimodal, scalable local inference with auth",
					groupId: "localai",
					groupLabel: "LocalAI",
					groupHint: "Multimodal, scalable local inference",
					methodId: "custom",
				},
				modelPicker: {
					label: "LocalAI (custom)",
					hint: "Enter LocalAI URL + API key + model",
					methodId: "custom",
				},
			},
			buildUnknownModelHint: () =>
				"LocalAI requires authentication to be registered as a provider. " +
				'Set LOCALAI_API_KEY (any value works) or run "openclaw configure". ' +
				"See: https://docs.openclaw.ai/providers/localai",
		});
	},
});
