import { C_ as normalizeTokenProviderInput, D_ as validateApiKeyInput, E_ as normalizeApiKeyInput, S_ as normalizeSecretInputModeInput, n as resolveAuthProfileOrder, p as ensureAuthProfileStore, x_ as ensureApiKeyFromOptionEnvOrPrompt, y_ as createAuthChoiceDefaultModelApplierForMutableState } from "./auth-profiles-DqxBs6Au.js";
import { r as applyAuthProfileConfig } from "./onboard-auth.config-shared-B0GfsgVQ.js";
import { i as LITELLM_DEFAULT_MODEL_REF, n as applyLitellmProviderConfig, o as setLitellmApiKey, t as applyLitellmConfig } from "./onboard-auth-0RfaRoQs.js";
import { a as resolveManifestProviderAuthChoice, i as resolveManifestProviderApiKeyChoice, r as normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy-aidPRzV-.js";
//#region src/commands/auth-choice.apply.api-key-providers.ts
async function applyLiteLlmApiKeyProvider({ params, authChoice, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride }) {
	if (authChoice !== "litellm-api-key") {return null;}
	let nextConfig = config;
	const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const existingProfileId = resolveAuthProfileOrder({
		cfg: nextConfig,
		store,
		provider: "litellm"
	}).find((profileId) => Boolean(store.profiles[profileId]));
	const existingCred = existingProfileId ? store.profiles[existingProfileId] : void 0;
	let profileId = "litellm:default";
	let hasCredential = Boolean(existingProfileId && existingCred?.type === "api_key");
	if (hasCredential && existingProfileId) {profileId = existingProfileId;}
	if (!hasCredential) {
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: normalizedTokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["litellm"],
			provider: "litellm",
			envLabel: "LITELLM_API_KEY",
			promptMessage: "Enter LiteLLM API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setLitellmApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
			noteMessage: "LiteLLM provides a unified API to 100+ LLM providers.\nGet your API key from your LiteLLM proxy or https://litellm.ai\nDefault proxy runs on http://localhost:4000",
			noteTitle: "LiteLLM"
		});
		hasCredential = true;
	}
	if (hasCredential) {nextConfig = applyAuthProfileConfig(nextConfig, {
		profileId,
		provider: "litellm",
		mode: "api_key"
	});}
	setConfig(nextConfig);
	await applyProviderDefaultModel({
		defaultModel: LITELLM_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyLitellmConfig,
		applyProviderConfig: applyLitellmProviderConfig,
		noteDefault: LITELLM_DEFAULT_MODEL_REF
	});
	return {
		config: getConfig(),
		agentModelOverride: getAgentModelOverride()
	};
}
//#endregion
//#region src/commands/auth-choice.apply.api-providers.ts
const CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES = { litellm: "litellm-api-key" };
function normalizeApiKeyTokenProviderAuthChoice(params) {
	if (params.authChoice !== "apiKey" || !params.tokenProvider) {return params.authChoice;}
	const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
	if (!normalizedTokenProvider) {return params.authChoice;}
	return resolveManifestProviderApiKeyChoice({
		providerId: normalizedTokenProvider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})?.choiceId ?? CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES[normalizedTokenProvider] ?? params.authChoice;
}
async function applyAuthChoiceApiProviders(params) {
	let nextConfig = params.config;
	let agentModelOverride;
	const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(params, () => nextConfig, (config) => nextConfig = config, () => agentModelOverride, (model) => agentModelOverride = model);
	const authChoice = normalizeApiKeyTokenProviderAuthChoice({
		authChoice: params.authChoice,
		tokenProvider: params.opts?.tokenProvider,
		config: params.config,
		env: process.env
	});
	const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	const litellmResult = await applyLiteLlmApiKeyProvider({
		params,
		authChoice,
		config: nextConfig,
		setConfig: (config) => nextConfig = config,
		getConfig: () => nextConfig,
		normalizedTokenProvider,
		requestedSecretInputMode,
		applyProviderDefaultModel,
		getAgentModelOverride: () => agentModelOverride
	});
	if (litellmResult) {return litellmResult;}
	return null;
}
//#endregion
//#region src/commands/auth-choice.preferred-provider.ts
const PREFERRED_PROVIDER_BY_AUTH_CHOICE = {
	chutes: "chutes",
	"litellm-api-key": "litellm",
	"custom-api-key": "custom"
};
async function resolvePreferredProviderForAuthChoice(params) {
	const choice = normalizeLegacyOnboardAuthChoice(params.choice) ?? params.choice;
	const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
	if (manifestResolved) {return manifestResolved.providerId;}
	const [{ resolveProviderPluginChoice }, { resolvePluginProviders }] = await Promise.all([import("./provider-wizard-DQTLY09c.js"), import("./providers-BDB6eTS8.js")]);
	const pluginResolved = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			bundledProviderAllowlistCompat: true,
			bundledProviderVitestCompat: true
		}),
		choice
	});
	if (pluginResolved) {return pluginResolved.provider.id;}
	const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
	if (preferred) {return preferred;}
}
//#endregion
export { applyAuthChoiceApiProviders as n, normalizeApiKeyTokenProviderAuthChoice as r, resolvePreferredProviderForAuthChoice as t };
