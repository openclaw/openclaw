import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as normalizeStaticProviderModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { t as resolveModelRuntimePolicy } from "./model-runtime-policy-CAe5ww09.js";
//#region src/agents/model-runtime-aliases.ts
const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
	{
		legacyProvider: "codex",
		provider: "openai",
		runtime: "codex",
		cli: false,
		requiresRuntimePolicy: false
	},
	{
		legacyProvider: "codex-cli",
		provider: "openai",
		runtime: "codex",
		cli: false,
		requiresRuntimePolicy: true
	},
	{
		legacyProvider: "claude-cli",
		provider: "anthropic",
		runtime: "claude-cli",
		cli: true,
		requiresRuntimePolicy: true
	},
	{
		legacyProvider: "google-gemini-cli",
		provider: "google",
		runtime: "google-gemini-cli",
		cli: true,
		requiresRuntimePolicy: true
	}
];
function legacyRuntimeModelAliasRequiresRuntimePolicy(provider) {
	return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.find((entry) => normalizeProviderId(entry.legacyProvider) === normalizeProviderId(provider))?.requiresRuntimePolicy === true;
}
const LEGACY_ALIAS_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [normalizeProviderId(entry.legacyProvider), entry]));
const CLI_RUNTIME_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => [`${normalizeProviderId(entry.provider)}:${normalizeProviderId(entry.runtime)}`, entry]));
const CLI_RUNTIME_ALIASES = new Set(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => normalizeProviderId(entry.runtime)));
const CLI_RUNTIME_PROVIDER_IDS = new Set(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => normalizeProviderId(entry.legacyProvider)));
const RUNTIME_COMPARISON_PROVIDER_ALIASES = new Map([["openai-codex", "openai"]]);
function listLegacyRuntimeModelProviderAliases() {
	return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES;
}
/** True for CLI runtime provider ids such as `claude-cli` and `google-gemini-cli`. */
function isCliRuntimeProvider(provider) {
	return CLI_RUNTIME_PROVIDER_IDS.has(normalizeProviderId(provider));
}
function resolveLegacyRuntimeModelProviderAlias(provider) {
	return LEGACY_ALIAS_BY_PROVIDER.get(normalizeProviderId(provider));
}
function migrateLegacyRuntimeModelRef(raw) {
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return null;
	const alias = resolveLegacyRuntimeModelProviderAlias(trimmed.slice(0, slash));
	if (!alias) return null;
	const rawModel = trimmed.slice(slash + 1).trim();
	const model = normalizeStaticProviderModelId(alias.provider, rawModel);
	if (!model) return null;
	return {
		ref: `${alias.provider}/${model}`,
		legacyProvider: alias.legacyProvider,
		provider: alias.provider,
		model,
		runtime: alias.runtime,
		cli: alias.cli
	};
}
/** Shared setup/default pickers hide all legacy runtime provider ids. */
function isLegacyRuntimeModelProvider(provider) {
	return resolveLegacyRuntimeModelProviderAlias(provider) !== void 0;
}
function isCliRuntimeAlias(runtime) {
	const normalized = runtime?.trim();
	return normalized ? CLI_RUNTIME_ALIASES.has(normalizeProviderId(normalized)) : false;
}
function canonicalizeRuntimeAliasProvider(provider) {
	const normalized = normalizeProviderId(provider);
	return RUNTIME_COMPARISON_PROVIDER_ALIASES.get(normalized) ?? resolveLegacyRuntimeModelProviderAlias(provider)?.provider ?? provider;
}
function normalizeRuntimeModelRefForComparison(raw) {
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return normalizeProviderId(canonicalizeRuntimeAliasProvider(trimmed));
	const provider = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	const canonicalProvider = normalizeProviderId(canonicalizeRuntimeAliasProvider(provider));
	return model ? `${canonicalProvider}/${model}` : canonicalProvider;
}
function areRuntimeModelRefsEquivalent(left, right) {
	return normalizeRuntimeModelRefForComparison(left) === normalizeRuntimeModelRefForComparison(right);
}
function resolveConfiguredRuntime(params) {
	return resolveModelRuntimePolicy({
		config: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId
	}).policy?.id?.trim();
}
function resolveProfileRuntimeAlias(params) {
	const profile = params.cfg?.auth?.profiles?.[params.profileId];
	if (!profile?.provider) return;
	const provider = normalizeProviderId(params.provider);
	const profileProvider = normalizeProviderId(profile.provider);
	if (!provider || !profileProvider) return;
	if (resolveProviderIdForAuth(provider, { config: params.cfg }) !== resolveProviderIdForAuth(profileProvider, { config: params.cfg })) return;
	return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${profileProvider}`)?.runtime;
}
function resolveCliRuntimeFromAuthProfile(params) {
	if (!params.cfg?.auth?.profiles) return;
	if (params.authProfileId?.trim()) return resolveProfileRuntimeAlias({
		cfg: params.cfg,
		provider: params.provider,
		profileId: params.authProfileId.trim()
	});
	const provider = normalizeProviderId(params.provider);
	const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
	const orderedProfileIds = [...params.cfg.auth.order?.[providerAuthKey] ?? [], ...providerAuthKey === provider ? [] : params.cfg.auth.order?.[provider] ?? []];
	for (const profileId of orderedProfileIds) {
		const profile = params.cfg.auth.profiles[profileId];
		if (!profile?.provider) continue;
		if (resolveProviderIdForAuth(profile.provider, { config: params.cfg }) !== providerAuthKey) continue;
		return resolveProfileRuntimeAlias({
			cfg: params.cfg,
			provider,
			profileId
		});
	}
	const compatibleProfileIds = Object.entries(params.cfg.auth.profiles).filter(([, profile]) => {
		if (!profile?.provider) return false;
		return resolveProviderIdForAuth(profile.provider, { config: params.cfg }) === providerAuthKey;
	}).map(([profileId]) => profileId);
	if (compatibleProfileIds.length !== 1) return;
	const [profileId] = compatibleProfileIds;
	return profileId ? resolveProfileRuntimeAlias({
		cfg: params.cfg,
		provider,
		profileId
	}) : void 0;
}
function resolveCliRuntimeExecutionProvider(params) {
	const provider = normalizeProviderId(params.provider);
	const runtime = resolveConfiguredRuntime({
		...params,
		provider
	});
	if (runtime === "pi") return;
	if (!runtime || runtime === "auto") return resolveCliRuntimeFromAuthProfile({
		...params,
		provider
	});
	return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${runtime}`)?.runtime;
}
//#endregion
export { legacyRuntimeModelAliasRequiresRuntimePolicy as a, resolveCliRuntimeExecutionProvider as c, isLegacyRuntimeModelProvider as i, isCliRuntimeAlias as n, listLegacyRuntimeModelProviderAliases as o, isCliRuntimeProvider as r, migrateLegacyRuntimeModelRef as s, areRuntimeModelRefsEquivalent as t };
