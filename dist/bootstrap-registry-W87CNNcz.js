import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as listChannelCatalogEntries } from "./channel-catalog-registry-DtJ_ZeqX.js";
import { a as getBundledChannelSetupPlugin, h as resolveBundledChannelRootScope, i as getBundledChannelSecrets, o as getBundledChannelSetupSecrets, r as getBundledChannelPlugin } from "./bundled-0oTAwz0N.js";
//#region src/channels/plugins/bundled-ids.ts
function listBundledChannelIdsForRoot(_packageRoot, env = process.env) {
	return listChannelCatalogEntries({
		origin: "bundled",
		env
	}).map((entry) => entry.channel.id).filter((channelId) => Boolean(channelId)).toSorted((left, right) => left.localeCompare(right));
}
function listBundledChannelIds(env = process.env) {
	return listBundledChannelIdsForRoot(resolveBundledChannelRootScope(env).cacheKey, env);
}
//#endregion
//#region src/channels/plugins/bootstrap-registry.ts
function resolveBootstrapChannelId(id) {
	return normalizeOptionalString(id) ?? "";
}
function mergePluginSection(runtimeValue, setupValue) {
	if (runtimeValue && setupValue && typeof runtimeValue === "object" && typeof setupValue === "object") {
		const merged = { ...runtimeValue };
		for (const [key, value] of Object.entries(setupValue)) if (value !== void 0) merged[key] = value;
		return { ...merged };
	}
	return setupValue ?? runtimeValue;
}
function mergeBootstrapPlugin(runtimePlugin, setupPlugin) {
	return {
		...runtimePlugin,
		...setupPlugin,
		meta: mergePluginSection(runtimePlugin.meta, setupPlugin.meta),
		capabilities: mergePluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
		commands: mergePluginSection(runtimePlugin.commands, setupPlugin.commands),
		doctor: mergePluginSection(runtimePlugin.doctor, setupPlugin.doctor),
		reload: mergePluginSection(runtimePlugin.reload, setupPlugin.reload),
		config: mergePluginSection(runtimePlugin.config, setupPlugin.config),
		setup: mergePluginSection(runtimePlugin.setup, setupPlugin.setup),
		messaging: mergePluginSection(runtimePlugin.messaging, setupPlugin.messaging),
		actions: mergePluginSection(runtimePlugin.actions, setupPlugin.actions),
		secrets: mergePluginSection(runtimePlugin.secrets, setupPlugin.secrets)
	};
}
function getBootstrapChannelPlugin(id) {
	const resolvedId = resolveBootstrapChannelId(id);
	if (!resolvedId) return;
	let runtimePlugin;
	let setupPlugin;
	try {
		runtimePlugin = getBundledChannelPlugin(resolvedId);
		setupPlugin = getBundledChannelSetupPlugin(resolvedId);
	} catch {
		return;
	}
	return runtimePlugin && setupPlugin ? mergeBootstrapPlugin(runtimePlugin, setupPlugin) : setupPlugin ?? runtimePlugin;
}
function getBootstrapChannelSecrets(id) {
	const resolvedId = resolveBootstrapChannelId(id);
	if (!resolvedId) return;
	try {
		return mergePluginSection(getBundledChannelSecrets(resolvedId), getBundledChannelSetupSecrets(resolvedId));
	} catch {
		return;
	}
}
//#endregion
export { getBootstrapChannelSecrets as n, listBundledChannelIds as r, getBootstrapChannelPlugin as t };
