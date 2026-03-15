import { eC as normalizeProviderId } from "./auth-profiles-DqxBs6Au.js";
//#region src/commands/oauth-flow.ts
const validateRequiredInput = (value) => value.trim().length > 0 ? void 0 : "Required";
function createVpsAwareOAuthHandlers(params) {
	const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
	let manualCodePromise;
	return {
		onAuth: async ({ url }) => {
			if (params.isRemote) {
				params.spin.stop("OAuth URL ready");
				params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
				manualCodePromise = params.prompter.text({
					message: manualPromptMessage,
					validate: validateRequiredInput
				}).then((value) => String(value));
				return;
			}
			params.spin.update(params.localBrowserMessage);
			await params.openUrl(url);
			params.runtime.log(`Open: ${url}`);
		},
		onPrompt: async (prompt) => {
			if (manualCodePromise) {return manualCodePromise;}
			const code = await params.prompter.text({
				message: prompt.message,
				placeholder: prompt.placeholder,
				validate: validateRequiredInput
			});
			return String(code);
		}
	};
}
//#endregion
//#region src/commands/provider-auth-helpers.ts
function resolveProviderMatch(providers, rawProvider) {
	const raw = rawProvider?.trim();
	if (!raw) {return null;}
	const normalized = normalizeProviderId(raw);
	return providers.find((provider) => normalizeProviderId(provider.id) === normalized) ?? providers.find((provider) => provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false) ?? null;
}
function pickAuthMethod(provider, rawMethod) {
	const raw = rawMethod?.trim();
	if (!raw) {return null;}
	const normalized = raw.toLowerCase();
	return provider.auth.find((method) => method.id.toLowerCase() === normalized) ?? provider.auth.find((method) => method.label.toLowerCase() === normalized) ?? null;
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function mergeConfigPatch(base, patch) {
	if (!isPlainRecord(base) || !isPlainRecord(patch)) {return patch;}
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const existing = next[key];
		if (isPlainRecord(existing) && isPlainRecord(value)) {next[key] = mergeConfigPatch(existing, value);}
		else {next[key] = value;}
	}
	return next;
}
function applyDefaultModel(cfg, model) {
	const models = { ...cfg.agents?.defaults?.models };
	models[model] = models[model] ?? {};
	const existingModel = cfg.agents?.defaults?.model;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models,
				model: {
					...existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? { fallbacks: existingModel.fallbacks } : void 0,
					primary: model
				}
			}
		}
	};
}
//#endregion
export { createVpsAwareOAuthHandlers as a, resolveProviderMatch as i, mergeConfigPatch as n, pickAuthMethod as r, applyDefaultModel as t };
