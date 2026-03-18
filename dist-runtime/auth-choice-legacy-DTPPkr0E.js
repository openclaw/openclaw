import { eC as normalizeProviderIdForAuth } from "./auth-profiles-DAOR1fRn.js";
import { n as loadPluginManifestRegistry } from "./manifest-registry-DZywV-kg.js";
//#region src/plugins/provider-auth-choices.ts
function resolveManifestProviderAuthChoices(params) {
	return loadPluginManifestRegistry({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env: params?.env
	}).plugins.flatMap((plugin) => (plugin.providerAuthChoices ?? []).map((choice) => ({
		pluginId: plugin.id,
		providerId: choice.provider,
		methodId: choice.method,
		choiceId: choice.choiceId,
		choiceLabel: choice.choiceLabel ?? choice.choiceId,
		...choice.choiceHint ? { choiceHint: choice.choiceHint } : {},
		...choice.groupId ? { groupId: choice.groupId } : {},
		...choice.groupLabel ? { groupLabel: choice.groupLabel } : {},
		...choice.groupHint ? { groupHint: choice.groupHint } : {},
		...choice.optionKey ? { optionKey: choice.optionKey } : {},
		...choice.cliFlag ? { cliFlag: choice.cliFlag } : {},
		...choice.cliOption ? { cliOption: choice.cliOption } : {},
		...choice.cliDescription ? { cliDescription: choice.cliDescription } : {}
	})));
}
function resolveManifestProviderAuthChoice(choiceId, params) {
	const normalized = choiceId.trim();
	if (!normalized) return;
	return resolveManifestProviderAuthChoices(params).find((choice) => choice.choiceId === normalized);
}
function resolveManifestProviderApiKeyChoice(params) {
	const normalizedProviderId = normalizeProviderIdForAuth(params.providerId);
	if (!normalizedProviderId) return;
	return resolveManifestProviderAuthChoices(params).find((choice) => {
		if (!choice.optionKey) return false;
		return normalizeProviderIdForAuth(choice.providerId) === normalizedProviderId;
	});
}
function resolveManifestProviderOnboardAuthFlags(params) {
	const flags = [];
	const seen = /* @__PURE__ */ new Set();
	for (const choice of resolveManifestProviderAuthChoices(params)) {
		if (!choice.optionKey || !choice.cliFlag || !choice.cliOption) continue;
		const dedupeKey = `${choice.optionKey}::${choice.cliFlag}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		flags.push({
			optionKey: choice.optionKey,
			authChoice: choice.choiceId,
			cliFlag: choice.cliFlag,
			cliOption: choice.cliOption,
			description: choice.cliDescription ?? choice.choiceLabel
		});
	}
	return flags;
}
//#endregion
//#region src/commands/auth-choice-legacy.ts
const AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI = [
	"setup-token",
	"oauth",
	"claude-cli",
	"codex-cli"
];
function normalizeLegacyOnboardAuthChoice(authChoice) {
	if (authChoice === "oauth" || authChoice === "claude-cli") return "setup-token";
	if (authChoice === "codex-cli") return "openai-codex";
	return authChoice;
}
function isDeprecatedAuthChoice(authChoice) {
	return authChoice === "claude-cli" || authChoice === "codex-cli";
}
//#endregion
export { resolveManifestProviderAuthChoice as a, resolveManifestProviderApiKeyChoice as i, isDeprecatedAuthChoice as n, resolveManifestProviderAuthChoices as o, normalizeLegacyOnboardAuthChoice as r, resolveManifestProviderOnboardAuthFlags as s, AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI as t };
