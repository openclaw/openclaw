import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { s as normalizeStringEntries } from "./string-normalization-rJ4BOsjW.js";
import { r as writeRuntimeJson } from "./runtime-Dv8n03pi.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir } from "./agent-scope-CzfWAE9r.js";
import { c as resolveAuthStatePathForDisplay } from "./source-check-CgrdYfQr.js";
import { n as ensureAuthProfileStore } from "./store-kA9k3QAn.js";
import "./model-selection-DqTgZ6sy.js";
import "./auth-profiles-CTRxy_8C.js";
import { n as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-yomk1YD5.js";
import { r as setAuthProfileOrder } from "./profiles-DIU0hInF.js";
import { s as resolveKnownAgentId } from "./shared-CDB1vyks.js";
import { t as loadModelsConfig } from "./load-config-E1cWZxRZ.js";
//#region src/commands/models/auth-order.ts
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
function describeOrder(store, provider) {
	const providerKey = normalizeProviderId(provider);
	const order = store.order?.[providerKey];
	return Array.isArray(order) ? order : [];
}
async function resolveAuthOrderContext(opts, runtime) {
	const rawProvider = opts.provider?.trim();
	if (!rawProvider) throw new Error("Missing --provider.");
	const provider = normalizeProviderId(rawProvider);
	const cfg = await loadModelsConfig({
		commandName: "models auth-order",
		runtime
	});
	const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
	return {
		cfg,
		agentId,
		agentDir,
		provider
	};
}
async function modelsAuthOrderGetCommand(opts, runtime) {
	const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	const order = describeOrder(ensureAuthProfileStore(agentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg,
		provider
	}) }), provider);
	if (opts.json) {
		writeRuntimeJson(runtime, {
			agentId,
			agentDir,
			provider,
			authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
			order: order.length > 0 ? order : null
		});
		return;
	}
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log(`Auth state file: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
	runtime.log(order.length > 0 ? `Order override: ${order.join(", ")}` : "Order override: (none)");
}
async function modelsAuthOrderClearCommand(opts, runtime) {
	const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	if (!await setAuthProfileOrder({
		agentDir,
		provider,
		order: null
	})) throw new Error("Failed to update auth-state.json (lock busy?).");
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log("Cleared per-agent order override.");
}
async function modelsAuthOrderSetCommand(opts, runtime) {
	const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	const store = ensureAuthProfileStore(agentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg,
		provider
	}) });
	const providerKey = provider;
	const requested = normalizeStringEntries(opts.order ?? []);
	if (requested.length === 0) throw new Error("Missing profile ids. Provide one or more profile ids.");
	for (const profileId of requested) {
		const cred = store.profiles[profileId];
		if (!cred) throw new Error(`Auth profile "${profileId}" not found in ${agentDir}.`);
		if (normalizeProviderId(cred.provider) !== providerKey) throw new Error(`Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`);
	}
	const updated = await setAuthProfileOrder({
		agentDir,
		provider,
		order: requested
	});
	if (!updated) throw new Error("Failed to update auth-state.json (lock busy?).");
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log(`Order override: ${describeOrder(updated, provider).join(", ")}`);
}
//#endregion
export { modelsAuthOrderClearCommand, modelsAuthOrderGetCommand, modelsAuthOrderSetCommand };
