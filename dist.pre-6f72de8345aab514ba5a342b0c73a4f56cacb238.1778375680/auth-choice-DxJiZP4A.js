import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { n as ensureAuthProfileStore } from "./store-BjI2Wn-k.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DDEg6aT2.js";
import "./auth-profiles-BwJpHxfd.js";
import { n as listProfilesForProvider } from "./profile-list-rB9AtIp4.js";
import { t as resolveEnvApiKey } from "./model-auth-env-BF8ht6Jp.js";
import { c as hasUsableCustomProviderApiKey } from "./model-auth-CoAt7J2b.js";
import { r as loadModelCatalog } from "./model-catalog-CWcd3ars.js";
import { t as applyAuthChoiceLoadedPluginProvider } from "./provider-auth-choice-BoHXJn03.js";
import { t as buildProviderAuthRecoveryHint } from "./provider-auth-guidance-DhvpIDOx.js";
import "./provider-auth-choice-preference-CduV1GAG.js";
//#region src/commands/auth-choice.apply.ts
async function normalizeLegacyChoice(authChoice, params) {
	if (authChoice === "oauth") return "setup-token";
	if (typeof authChoice !== "string" || !authChoice.endsWith("-cli")) return authChoice;
	const { normalizeLegacyOnboardAuthChoice } = await import("./auth-choice-legacy-zwc_3c3H.js");
	return normalizeLegacyOnboardAuthChoice(authChoice, params);
}
async function normalizeTokenProviderChoice(params) {
	if (!params.source.opts?.tokenProvider) return params.authChoice;
	if (params.authChoice !== "apiKey" && params.authChoice !== "token" && params.authChoice !== "setup-token") return params.authChoice;
	const { normalizeApiKeyTokenProviderAuthChoice } = await import("./auth-choice.apply.api-providers-D0wtgTQ1.js");
	return normalizeApiKeyTokenProviderAuthChoice({
		authChoice: params.authChoice,
		tokenProvider: params.source.opts.tokenProvider,
		config: params.source.config,
		env: params.source.env
	});
}
async function formatDeprecatedProviderChoiceError(authChoice, params) {
	if (typeof authChoice !== "string") return;
	const { resolveManifestDeprecatedProviderAuthChoice } = await import("./provider-auth-choices-e5D7iHsK.js");
	const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice, {
		config: params.config,
		env: params.env
	});
	if (!deprecatedChoice) return;
	return `Auth choice ${JSON.stringify(authChoice)} is no longer supported. Use ${JSON.stringify(deprecatedChoice.choiceId)} instead, or run ${formatCliCommand("openclaw onboard")} to choose interactively.`;
}
async function applyAuthChoice(params) {
	const normalizedProviderAuthChoice = await normalizeTokenProviderChoice({
		authChoice: await normalizeLegacyChoice(params.authChoice, {
			config: params.config,
			env: params.env
		}) ?? params.authChoice,
		source: params
	});
	const normalizedParams = normalizedProviderAuthChoice === params.authChoice ? params : {
		...params,
		authChoice: normalizedProviderAuthChoice
	};
	const result = await applyAuthChoiceLoadedPluginProvider(normalizedParams);
	if (result) return result;
	const deprecatedProviderChoiceError = await formatDeprecatedProviderChoiceError(normalizedParams.authChoice, {
		config: normalizedParams.config,
		env: normalizedParams.env
	});
	if (deprecatedProviderChoiceError) throw new Error(deprecatedProviderChoiceError);
	if (normalizedParams.authChoice === "token" || normalizedParams.authChoice === "setup-token") throw new Error([`Auth choice "${normalizedParams.authChoice}" was not matched to a provider setup flow.`, `Run ${formatCliCommand("openclaw models auth login --provider <provider>")} for provider auth, or rerun ${formatCliCommand("openclaw onboard")} to choose interactively.`].join("\n"));
	if (normalizedParams.authChoice === "oauth") throw new Error(`Auth choice "oauth" is no longer supported directly. Use a provider-specific auth entry, or run ${formatCliCommand("openclaw models auth login --provider <provider>")}.`);
	return { config: normalizedParams.config };
}
//#endregion
//#region src/commands/auth-choice.model-check.ts
async function warnIfModelConfigLooksOff(config, prompter, options) {
	const ref = resolveDefaultModelForAgent({
		cfg: config,
		agentId: options?.agentId
	});
	const warnings = [];
	if (options?.validateCatalog !== false) {
		const catalog = await loadModelCatalog({
			config,
			useCache: false
		});
		if (catalog.length > 0) {
			if (!catalog.some((entry) => entry.provider === ref.provider && entry.id === ref.model)) warnings.push(`Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`);
		}
	}
	const hasProfile = listProfilesForProvider(ensureAuthProfileStore(options?.agentDir), ref.provider).length > 0;
	const envKey = resolveEnvApiKey(ref.provider);
	const hasCustomKey = hasUsableCustomProviderApiKey(config, ref.provider);
	if (!hasProfile && !envKey && !hasCustomKey) warnings.push(`No auth configured for provider "${ref.provider}". The agent may fail until credentials are added. ${buildProviderAuthRecoveryHint({
		provider: ref.provider,
		config,
		includeEnvVar: true
	})}`);
	if (warnings.length > 0) await prompter.note(warnings.join("\n"), "Model check");
}
//#endregion
export { applyAuthChoice as n, warnIfModelConfigLooksOff as t };
