import { n as ensureAuthProfileStore } from "./store-H1X3llav.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-BP-YASdB.js";
import "./auth-profiles-Ch3QVcfx.js";
import { n as listProfilesForProvider } from "./profile-list-CVSfDnvE.js";
import { t as resolveEnvApiKey } from "./model-auth-env-BF_4o7uI.js";
import { c as hasUsableCustomProviderApiKey } from "./model-auth-Atvm_2TG.js";
import { r as loadModelCatalog } from "./model-catalog-D3O5e8PY.js";
import { t as applyAuthChoiceLoadedPluginProvider } from "./provider-auth-choice-8E6JU0Qv.js";
import { t as buildProviderAuthRecoveryHint } from "./provider-auth-guidance-DcER5L4Z.js";
import "./provider-auth-choice-preference-DYcHnYmR.js";
//#region src/commands/auth-choice.apply.ts
async function normalizeLegacyChoice(authChoice, params) {
	if (authChoice === "oauth") return "setup-token";
	if (typeof authChoice !== "string" || !authChoice.endsWith("-cli")) return authChoice;
	const { normalizeLegacyOnboardAuthChoice } = await import("./auth-choice-legacy-CihisY7u.js");
	return normalizeLegacyOnboardAuthChoice(authChoice, params);
}
async function normalizeTokenProviderChoice(params) {
	if (!params.source.opts?.tokenProvider) return params.authChoice;
	if (params.authChoice !== "apiKey" && params.authChoice !== "token" && params.authChoice !== "setup-token") return params.authChoice;
	const { normalizeApiKeyTokenProviderAuthChoice } = await import("./auth-choice.apply.api-providers-Bw_5sVpD.js");
	return normalizeApiKeyTokenProviderAuthChoice({
		authChoice: params.authChoice,
		tokenProvider: params.source.opts.tokenProvider,
		config: params.source.config,
		env: params.source.env
	});
}
async function formatDeprecatedProviderChoiceError(authChoice, params) {
	if (typeof authChoice !== "string") return;
	const { resolveManifestDeprecatedProviderAuthChoice } = await import("./provider-auth-choices-Bg-bLxg3.js");
	const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice, {
		config: params.config,
		env: params.env
	});
	if (!deprecatedChoice) return;
	return `Auth choice ${JSON.stringify(authChoice)} is no longer supported. Use ${JSON.stringify(deprecatedChoice.choiceId)} instead.`;
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
	if (normalizedParams.authChoice === "token" || normalizedParams.authChoice === "setup-token") throw new Error([`Auth choice "${normalizedParams.authChoice}" was not matched to a provider setup flow.`, "For Anthropic legacy token auth, use \"setup-token\" with tokenProvider=\"anthropic\" or choose the Anthropic setup-token entry explicitly."].join("\n"));
	if (normalizedParams.authChoice === "oauth") throw new Error("Auth choice \"oauth\" is no longer supported directly. Use \"setup-token\" for Anthropic legacy token auth or a provider-specific OAuth entry.");
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
