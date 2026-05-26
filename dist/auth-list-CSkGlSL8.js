import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as resolveAuthStatePathForDisplay } from "./path-resolve-C6Vj5eOM.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./model-selection-P-81eBKx.js";
import { i as resolveAuthProfileDisplayLabel } from "./auth-profiles-D6NMnufG.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-D0JQl8du.js";
import { s as resolveKnownAgentId } from "./shared-CXerptPG.js";
import { t as loadModelsConfig } from "./load-config-B1XseUf7.js";
//#region src/commands/models/auth-list.ts
function resolveProviderFilter(rawProvider) {
	const provider = rawProvider?.trim() ? normalizeProviderId(rawProvider) : void 0;
	if (!provider) return {
		provider: void 0,
		externalCliProvider: void 0,
		matches: () => true
	};
	if (provider === "openai") return {
		provider,
		externalCliProvider: "openai-codex",
		matches: (profile) => profile.provider === "openai" || profile.provider === "openai-codex"
	};
	return {
		provider,
		externalCliProvider: provider,
		matches: (profile) => profile.provider === provider
	};
}
function resolveTargetAgent(cfg, raw) {
	const agentId = resolveKnownAgentId({
		cfg,
		rawAgentId: raw
	}) ?? resolveDefaultAgentId(cfg);
	return {
		agentId,
		agentDir: resolveAgentDir(cfg, agentId)
	};
}
function formatTimestamp(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return new Date(value).toISOString();
}
function resolveProfileExpiry(profile) {
	return profile.type === "api_key" ? void 0 : formatTimestamp(profile.expires);
}
function summarizeProfile(params) {
	const expiresAt = resolveProfileExpiry(params.profile);
	const cooldownUntil = formatTimestamp(params.usage?.cooldownUntil);
	const disabledUntil = formatTimestamp(params.usage?.disabledUntil);
	return {
		id: params.profileId,
		provider: normalizeProviderId(params.profile.provider),
		type: params.profile.type,
		label: resolveAuthProfileDisplayLabel({
			cfg: params.cfg,
			store: params.store,
			profileId: params.profileId
		}),
		...params.profile.email ? { email: params.profile.email } : {},
		...params.profile.displayName ? { displayName: params.profile.displayName } : {},
		...expiresAt ? { expiresAt } : {},
		...cooldownUntil ? { cooldownUntil } : {},
		...disabledUntil ? { disabledUntil } : {}
	};
}
function formatProfileLine(profile) {
	const details = [`${profile.provider}/${profile.type}`];
	if (profile.expiresAt) details.push(`expires ${profile.expiresAt}`);
	if (profile.cooldownUntil) details.push(`cooldown until ${profile.cooldownUntil}`);
	if (profile.disabledUntil) details.push(`disabled until ${profile.disabledUntil}`);
	return `- ${profile.label} [${details.join("; ")}]`;
}
async function modelsAuthListCommand(opts, runtime) {
	const cfg = await loadModelsConfig({
		commandName: "models auth list",
		runtime
	});
	const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
	const providerFilter = resolveProviderFilter(opts.provider);
	const store = ensureAuthProfileStore(agentDir, providerFilter.externalCliProvider ? { externalCli: externalCliDiscoveryForProviderAuth({
		cfg,
		provider: providerFilter.externalCliProvider
	}) } : void 0);
	const profiles = Object.entries(store.profiles).map(([profileId, profile]) => summarizeProfile({
		cfg,
		store,
		profileId,
		profile,
		usage: store.usageStats?.[profileId]
	})).filter((profile) => providerFilter.matches(profile)).toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	if (opts.json) {
		writeRuntimeJson(runtime, {
			agentId,
			agentDir: shortenHomePath(agentDir),
			authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
			provider: providerFilter.provider ?? null,
			profiles
		});
		return;
	}
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Auth state file: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
	if (providerFilter.provider) runtime.log(`Provider: ${providerFilter.provider}`);
	if (profiles.length === 0) {
		runtime.log("Profiles: (none)");
		return;
	}
	runtime.log("Profiles:");
	for (const profile of profiles) runtime.log(formatProfileLine(profile));
}
//#endregion
export { modelsAuthListCommand };
