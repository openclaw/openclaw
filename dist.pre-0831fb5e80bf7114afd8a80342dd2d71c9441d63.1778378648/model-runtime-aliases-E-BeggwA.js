import { r as normalizeProviderId } from "./provider-id-C3dkeX_L.js";
import { t as resolveModelRuntimePolicy } from "./model-runtime-policy-CQI6M4jC.js";
import { i as normalizeStaticProviderModelId } from "./model-ref-shared-B-XKgocr.js";
//#region src/agents/model-runtime-aliases.ts
const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
	{
		legacyProvider: "codex",
		provider: "openai",
		runtime: "codex",
		cli: false
	},
	{
		legacyProvider: "codex-cli",
		provider: "openai",
		runtime: "codex-cli",
		cli: true
	},
	{
		legacyProvider: "claude-cli",
		provider: "anthropic",
		runtime: "claude-cli",
		cli: true
	},
	{
		legacyProvider: "google-gemini-cli",
		provider: "google",
		runtime: "google-gemini-cli",
		cli: true
	}
];
const LEGACY_ALIAS_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [normalizeProviderId(entry.legacyProvider), entry]));
const CLI_RUNTIME_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => [`${normalizeProviderId(entry.provider)}:${normalizeProviderId(entry.runtime)}`, entry]));
new Set(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => normalizeProviderId(entry.runtime)));
function listLegacyRuntimeModelProviderAliases() {
	return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES;
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
function isLegacyRuntimeModelProvider(provider) {
	return Boolean(resolveLegacyRuntimeModelProviderAlias(provider));
}
function resolveConfiguredRuntime(params) {
	return resolveModelRuntimePolicy({
		config: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId
	}).policy?.id?.trim();
}
function resolveCliRuntimeExecutionProvider(params) {
	const provider = normalizeProviderId(params.provider);
	const runtime = resolveConfiguredRuntime({
		...params,
		provider
	});
	if (!runtime || runtime === "auto" || runtime === "pi") return;
	return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${runtime}`)?.runtime;
}
//#endregion
export { resolveCliRuntimeExecutionProvider as i, listLegacyRuntimeModelProviderAliases as n, migrateLegacyRuntimeModelRef as r, isLegacyRuntimeModelProvider as t };
