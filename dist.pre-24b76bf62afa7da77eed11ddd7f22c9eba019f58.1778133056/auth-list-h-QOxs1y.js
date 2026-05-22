import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir } from "./agent-scope-eOlEQiLx.js";
import { r as writeRuntimeJson } from "./runtime-CFpTi2zA.js";
import { r as normalizeProviderId } from "./provider-id-DifICj6R.js";
import { c as resolveAuthStatePathForDisplay } from "./source-check-BkK5JqJj.js";
import { n as ensureAuthProfileStore } from "./store-H1X3llav.js";
import "./model-selection-BP-YASdB.js";
import { i as resolveAuthProfileDisplayLabel } from "./auth-profiles-Ch3QVcfx.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-slbjBE7g.js";
import { s as resolveKnownAgentId } from "./shared-D_Y3iFyw.js";
import { t as loadModelsConfig } from "./load-config-Bhgvw8zR.js";
//#region src/commands/models/auth-list.ts
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
	const provider = opts.provider?.trim() ? normalizeProviderId(opts.provider) : void 0;
	const store = ensureAuthProfileStore(agentDir, provider ? { externalCli: externalCliDiscoveryForProviderAuth({
		cfg,
		provider
	}) } : void 0);
	const profiles = Object.entries(store.profiles).map(([profileId, profile]) => summarizeProfile({
		cfg,
		store,
		profileId,
		profile,
		usage: store.usageStats?.[profileId]
	})).filter((profile) => !provider || profile.provider === provider).toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	if (opts.json) {
		writeRuntimeJson(runtime, {
			agentId,
			agentDir: shortenHomePath(agentDir),
			authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
			provider: provider ?? null,
			profiles
		});
		return;
	}
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Auth state file: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
	if (provider) runtime.log(`Provider: ${provider}`);
	if (profiles.length === 0) {
		runtime.log("Profiles: (none)");
		return;
	}
	runtime.log("Profiles:");
	for (const profile of profiles) runtime.log(formatProfileLine(profile));
}
//#endregion
export { modelsAuthListCommand };
