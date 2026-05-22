import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import { k as readCodexCliCredentialsCached, l as loadAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-DjSzcW5t.js";
import "./model-selection-BWQiz_aq.js";
import { i as resolveAuthProfileDisplayLabel } from "./auth-profiles-BavBg7q6.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-g_CjBnn-.js";
import { n as resolveAuthProfileOrder } from "./order-Djk_ZE8S.js";
import { t as resolveEnvApiKey } from "./model-auth-env-Cac5DnRw.js";
import { d as resolveUsableCustomProviderApiKey } from "./model-auth-Bbb7JlKK.js";
//#region src/agents/model-auth-label.ts
function resolveModelAuthLabel(params) {
	const resolvedProvider = params.provider?.trim();
	if (!resolvedProvider) return;
	const providerKey = normalizeProviderId(resolvedProvider);
	const store = params.includeExternalProfiles === false ? loadAuthProfileStoreWithoutExternalProfiles(params.agentDir) : ensureAuthProfileStore(params.agentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg: params.cfg,
		provider: providerKey,
		preferredProfile: params.sessionEntry?.authProfileOverride
	}) });
	const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
	const candidates = [profileOverride, ...resolveAuthProfileOrder({
		cfg: params.cfg,
		store,
		provider: providerKey,
		preferredProfile: profileOverride
	})].filter(Boolean);
	for (const profileId of candidates) {
		const profile = store.profiles[profileId];
		if (!profile || normalizeProviderId(profile.provider) !== providerKey) continue;
		const label = resolveAuthProfileDisplayLabel({
			cfg: params.cfg,
			store,
			profileId
		});
		if (profile.type === "oauth") return `oauth${label ? ` (${label})` : ""}`;
		if (profile.type === "token") return `token${label ? ` (${label})` : ""}`;
		return `api-key${label ? ` (${label})` : ""}`;
	}
	const envKey = resolveEnvApiKey(providerKey, process.env, {
		config: params.cfg,
		workspaceDir: params.workspaceDir
	});
	if (envKey?.apiKey) {
		if (envKey.source.includes("OAUTH_TOKEN")) return `oauth (${envKey.source})`;
		return `api-key (${envKey.source})`;
	}
	if (providerKey === "codex" && readCodexCliCredentialsCached({
		ttlMs: 5e3,
		allowKeychainPrompt: false
	})) return "oauth (codex-cli)";
	if (resolveUsableCustomProviderApiKey({
		cfg: params.cfg,
		provider: providerKey
	})) return `api-key (models.json)`;
	return "unknown";
}
//#endregion
export { resolveModelAuthLabel as t };
