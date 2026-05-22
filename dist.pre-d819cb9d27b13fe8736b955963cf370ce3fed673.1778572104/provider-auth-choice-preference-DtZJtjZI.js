import { r as resolveManifestProviderAuthChoice } from "./provider-auth-choices-Bnv-p2ul.js";
import { r as normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy-BM63caIV.js";
//#region src/plugins/provider-auth-choice-preference.ts
function normalizeLegacyAuthChoice(choice, env) {
	return normalizeLegacyOnboardAuthChoice(choice, { env }) ?? choice;
}
async function resolvePreferredProviderForAuthChoice(params) {
	const choice = normalizeLegacyAuthChoice(params.choice, params.env) ?? params.choice;
	const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
	if (manifestResolved) return manifestResolved.providerId;
	const { resolveProviderPluginChoice, resolvePluginProviders } = await import("./provider-auth-choice.runtime-BGq00Cmf.js");
	const pluginResolved = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			mode: "setup",
			includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins
		}),
		choice
	});
	if (pluginResolved) return pluginResolved.provider.id;
	if (choice === "custom-api-key") return "custom";
}
//#endregion
export { resolvePreferredProviderForAuthChoice as t };
