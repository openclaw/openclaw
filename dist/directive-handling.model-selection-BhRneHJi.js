import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { a as findPersistedAuthProfileCredential, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { u as isModelKeyAllowedBySet, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import "./auth-profiles-D6NMnufG.js";
import { n as resolveModelDirectiveSelection } from "./model-selection-directive-3KE2MNNY.js";
import "./model-selection-C4Od5Khe.js";
//#region src/auto-reply/reply/directive-handling.auth-profile.ts
function resolveProfileOverride(params) {
	const raw = normalizeOptionalString(params.rawProfile);
	if (!raw) return {};
	const persistedProfile = findPersistedAuthProfileCredential({
		agentDir: params.agentDir,
		profileId: raw
	});
	if (persistedProfile) {
		if (persistedProfile.provider !== params.provider) return { error: `Auth profile "${raw}" is for ${persistedProfile.provider}, not ${params.provider}.` };
		return { profileId: raw };
	}
	const profile = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[raw];
	if (!profile) return { error: `Auth profile "${raw}" not found.` };
	if (profile.provider !== params.provider) return { error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.` };
	return { profileId: raw };
}
//#endregion
//#region src/auto-reply/reply/directive-handling.model-selection.ts
function resolveStoredNumericProfileModelDirective(params) {
	const trimmed = params.raw.trim();
	const lastSlash = trimmed.lastIndexOf("/");
	const profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
	if (profileDelimiter <= 0) return null;
	const profileId = trimmed.slice(profileDelimiter + 1).trim();
	if (!/^\d{8}$/.test(profileId)) return null;
	const modelRaw = trimmed.slice(0, profileDelimiter).trim();
	if (!modelRaw) return null;
	const profile = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[profileId];
	if (!profile) return null;
	return {
		modelRaw,
		profileId,
		profileProvider: profile.provider
	};
}
function resolveModelSelectionFromDirective(params) {
	if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
		if (params.directives.rawModelProfile) return { errorText: "Auth profile override requires a model selection." };
		return {};
	}
	const raw = params.directives.rawModelDirective.trim();
	if (/^default$/i.test(raw)) return { modelSelection: {
		provider: params.defaultProvider,
		model: params.defaultModel,
		isDefault: true
	} };
	const storedNumericProfile = params.directives.rawModelProfile === void 0 ? resolveStoredNumericProfileModelDirective({
		raw,
		agentDir: params.agentDir
	}) : null;
	const storedNumericProfileSelection = storedNumericProfile ? resolveModelDirectiveSelection({
		raw: storedNumericProfile.modelRaw,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		aliasIndex: params.aliasIndex,
		allowedModelKeys: params.allowedModelKeys,
		rawRuntime: params.directives.rawModelRuntime
	}) : null;
	const useStoredNumericProfile = Boolean(storedNumericProfileSelection?.selection) && resolveProviderIdForAuth(storedNumericProfileSelection?.selection?.provider ?? "", { config: params.cfg }) === resolveProviderIdForAuth(storedNumericProfile?.profileProvider ?? "", { config: params.cfg });
	const modelRaw = useStoredNumericProfile && storedNumericProfile ? storedNumericProfile.modelRaw : raw;
	let modelSelection;
	if (/^[0-9]+$/.test(raw)) return { errorText: [
		"Numeric model selection is not supported in chat.",
		"",
		"Browse: /models or /models <provider>",
		"Switch: /model <provider/model>"
	].join("\n") };
	const explicit = resolveModelRefFromString({
		raw: modelRaw,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	});
	if (explicit) {
		const explicitKey = modelKey(explicit.ref.provider, explicit.ref.model);
		if (params.allowedModelKeys.size === 0 || isModelKeyAllowedBySet(params.allowedModelKeys, explicitKey)) modelSelection = {
			provider: explicit.ref.provider,
			model: explicit.ref.model,
			isDefault: explicit.ref.provider === params.defaultProvider && explicit.ref.model === params.defaultModel,
			...explicit.alias ? { alias: explicit.alias } : {}
		};
	}
	if (!modelSelection) {
		const resolved = resolveModelDirectiveSelection({
			raw: modelRaw,
			defaultProvider: params.defaultProvider,
			defaultModel: params.defaultModel,
			aliasIndex: params.aliasIndex,
			allowedModelKeys: params.allowedModelKeys,
			rawRuntime: params.directives.rawModelRuntime
		});
		if (resolved.error) return { errorText: resolved.error };
		if (resolved.selection) modelSelection = resolved.selection;
	}
	let profileOverride;
	const rawProfile = params.directives.rawModelProfile ?? (useStoredNumericProfile ? storedNumericProfile?.profileId : void 0);
	if (modelSelection && rawProfile) {
		const profileResolved = resolveProfileOverride({
			rawProfile,
			provider: modelSelection.provider,
			cfg: params.cfg,
			agentDir: params.agentDir
		});
		if (profileResolved.error) return { errorText: profileResolved.error };
		profileOverride = profileResolved.profileId;
	}
	return {
		modelSelection,
		profileOverride
	};
}
//#endregion
export { resolveModelSelectionFromDirective as t };
