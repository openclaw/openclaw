import { t as unwrapDefaultModuleExport } from "./module-export-COvD9dVR.js";
import { t as isChannelConfigured } from "./channel-configured-B6BYuKoD.js";
//#region src/plugins/loader-channel-setup.ts
function mergeChannelPluginSection(baseValue, overrideValue) {
	if (baseValue && overrideValue && typeof baseValue === "object" && typeof overrideValue === "object") {
		const merged = { ...baseValue };
		for (const [key, value] of Object.entries(overrideValue)) if (value !== void 0) merged[key] = value;
		return { ...merged };
	}
	return overrideValue ?? baseValue;
}
function mergeSetupRuntimeChannelPlugin(runtimePlugin, setupPlugin) {
	return {
		...runtimePlugin,
		...setupPlugin,
		meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
		capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
		commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
		doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
		reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
		config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
		setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup),
		messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
		actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
		secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets)
	};
}
function resolveBundledRuntimeChannelRegistration(moduleExport) {
	const resolved = unwrapDefaultModuleExport(moduleExport);
	if (!resolved || typeof resolved !== "object") return {};
	const entryRecord = resolved;
	if (entryRecord.kind !== "bundled-channel-entry" || typeof entryRecord.id !== "string" || typeof entryRecord.loadChannelPlugin !== "function") return {};
	return {
		id: entryRecord.id,
		loadChannelPlugin: entryRecord.loadChannelPlugin,
		...typeof entryRecord.loadChannelSecrets === "function" ? { loadChannelSecrets: entryRecord.loadChannelSecrets } : {},
		...typeof entryRecord.setChannelRuntime === "function" ? { setChannelRuntime: entryRecord.setChannelRuntime } : {}
	};
}
function loadBundledRuntimeChannelPlugin(params) {
	if (typeof params.registration.loadChannelPlugin !== "function") return {};
	try {
		const loadedPlugin = params.registration.loadChannelPlugin();
		const loadedSecrets = params.registration.loadChannelSecrets?.();
		if (!loadedPlugin || typeof loadedPlugin !== "object") return {};
		const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
		return { plugin: {
			...loadedPlugin,
			...mergedSecrets !== void 0 ? { secrets: mergedSecrets } : {}
		} };
	} catch (err) {
		return { loadError: err };
	}
}
function resolveSetupChannelRegistration(moduleExport) {
	const resolved = unwrapDefaultModuleExport(moduleExport);
	if (!resolved || typeof resolved !== "object") return {};
	const setupEntryRecord = resolved;
	if (setupEntryRecord.kind === "bundled-channel-setup-entry" && typeof setupEntryRecord.loadSetupPlugin === "function") try {
		const loadedPlugin = setupEntryRecord.loadSetupPlugin();
		const loadedSecrets = typeof setupEntryRecord.loadSetupSecrets === "function" ? setupEntryRecord.loadSetupSecrets() : void 0;
		if (loadedPlugin && typeof loadedPlugin === "object") {
			const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
			return {
				plugin: {
					...loadedPlugin,
					...mergedSecrets !== void 0 ? { secrets: mergedSecrets } : {}
				},
				usesBundledSetupContract: true,
				...typeof setupEntryRecord.setChannelRuntime === "function" ? { setChannelRuntime: setupEntryRecord.setChannelRuntime } : {}
			};
		}
	} catch (err) {
		return { loadError: err };
	}
	const setup = resolved;
	if (!setup.plugin || typeof setup.plugin !== "object") return {};
	return {
		plugin: setup.plugin,
		...typeof setup.setChannelRuntime === "function" ? { setChannelRuntime: setup.setChannelRuntime } : {}
	};
}
function shouldLoadChannelPluginInSetupRuntime(params) {
	if (!params.setupSource || params.manifestChannels.length === 0) return false;
	if (params.preferSetupRuntimeForChannelPlugins && params.startupDeferConfiguredChannelFullLoadUntilAfterListen === true) return true;
	return !params.manifestChannels.some((channelId) => isChannelConfigured(params.cfg, channelId, params.env));
}
function channelPluginIdBelongsToManifest(params) {
	if (!params.channelId) return true;
	return params.channelId === params.pluginId || params.manifestChannels.includes(params.channelId);
}
//#endregion
export { resolveSetupChannelRegistration as a, resolveBundledRuntimeChannelRegistration as i, loadBundledRuntimeChannelPlugin as n, shouldLoadChannelPluginInSetupRuntime as o, mergeSetupRuntimeChannelPlugin as r, channelPluginIdBelongsToManifest as t };
