import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as resolveProviderAuthAliasMap } from "./provider-auth-aliases-4jqi6Djx.js";
import "./model-selection-P-81eBKx.js";
import { i as resolveManifestProviderAuthChoices } from "./provider-auth-choices-BFWeF5vS.js";
//#region src/commands/provider-auth-guidance.ts
function normalizeProviderIdForAuth(providerId, aliases) {
	const normalized = normalizeProviderId(providerId);
	return normalized ? aliases[normalized] ?? normalized : normalized;
}
function matchesProviderAuthChoice(choice, providerId, aliases) {
	const normalized = normalizeProviderIdForAuth(providerId, aliases);
	if (!normalized) return false;
	return normalizeProviderIdForAuth(choice.providerId, aliases) === normalized;
}
function resolveProviderAuthLoginCommand(params) {
	const aliases = resolveProviderAuthAliasMap(params);
	const choice = resolveManifestProviderAuthChoices(params).find((candidate) => matchesProviderAuthChoice(candidate, params.provider, aliases));
	if (!choice) return;
	return formatCliCommand(`openclaw models auth login --provider ${choice.providerId}`);
}
function buildProviderAuthRecoveryHint(params) {
	const loginCommand = resolveProviderAuthLoginCommand(params);
	const parts = [];
	if (loginCommand) parts.push(`Run \`${loginCommand}\``);
	if (params.includeConfigure !== false) parts.push(`\`${formatCliCommand("openclaw configure")}\``);
	if (params.includeEnvVar) parts.push("set an API key env var");
	if (parts.length === 0) return `Run \`${formatCliCommand("openclaw configure")}\`.`;
	if (parts.length === 1) return `${parts[0]}.`;
	if (parts.length === 2) return `${parts[0]} or ${parts[1]}.`;
	return `${parts[0]}, ${parts[1]}, or ${parts[2]}.`;
}
//#endregion
export { buildProviderAuthRecoveryHint as t };
