import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as listChannelCatalogEntries } from "./channel-catalog-registry-C9-YLpU9.js";
import { a as getBundledChannelSetupSecrets, i as getBundledChannelSetupPlugin, m as resolveBundledChannelRootScope, n as getBundledChannelPlugin, r as getBundledChannelSecrets } from "./bundled-CLIYaHBU.js";
//#region src/channels/plugins/bundled-ids.ts
function listBundledChannelPluginIdsForRoot(_packageRoot, env = process.env) {
	return listChannelCatalogEntries({
		origin: "bundled",
		env
	}).map((entry) => entry.pluginId).toSorted((left, right) => left.localeCompare(right));
}
function listBundledChannelPluginIds(env = process.env) {
	return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope(env).cacheKey, env);
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
function listBootstrapChannelPluginIds() {
	return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope().cacheKey);
}
function* iterateBootstrapChannelPlugins() {
	for (const id of listBootstrapChannelPluginIds()) {
		const plugin = getBootstrapChannelPlugin(id);
		if (plugin) yield plugin;
	}
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
export { listBundledChannelPluginIds as i, getBootstrapChannelSecrets as n, iterateBootstrapChannelPlugins as r, getBootstrapChannelPlugin as t };
