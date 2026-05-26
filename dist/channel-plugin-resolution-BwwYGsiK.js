import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as createClackPrompter } from "./clack-prompter-BZIQivnq.js";
import { r as listChannelPluginCatalogEntries } from "./catalog-Cw2Qtjnc.js";
import { n as loadChannelSetupPluginRegistrySnapshotForChannel, t as ensureChannelSetupPluginInstalled } from "./plugin-install-BvWiJ10m.js";
import { r as listTrustedChannelPluginCatalogEntries, t as getTrustedChannelPluginCatalogEntry } from "./trusted-catalog-ax5bRVns.js";
//#region src/commands/channel-setup/channel-plugin-resolution.ts
function resolveWorkspaceDir(cfg) {
	return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
function resolveResolvedChannelId(params) {
	const normalized = normalizeChannelId(params.rawChannel);
	if (normalized) return normalized;
	if (!params.catalogEntry) return;
	return normalizeChannelId(params.catalogEntry.id) ?? params.catalogEntry.id;
}
function resolveCatalogChannelEntry(raw, cfg) {
	const trimmed = normalizeOptionalLowercaseString(raw);
	if (!trimmed) return;
	return (cfg ? listTrustedChannelPluginCatalogEntries({
		cfg,
		workspaceDir: resolveWorkspaceDir(cfg)
	}) : listChannelPluginCatalogEntries({ excludeWorkspace: true })).find((entry) => {
		if (normalizeOptionalLowercaseString(entry.id) === trimmed) return true;
		return (entry.meta.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === trimmed);
	});
}
function findScopedChannelPlugin(snapshot, channelId, supports) {
	const runtimePlugin = snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin;
	if (runtimePlugin) return runtimePlugin;
	const setupPlugin = snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin;
	return setupPlugin && supports(setupPlugin) ? setupPlugin : void 0;
}
function loadScopedChannelPlugin(params) {
	return findScopedChannelPlugin(loadChannelSetupPluginRegistrySnapshotForChannel({
		cfg: params.cfg,
		runtime: params.runtime,
		channel: params.channelId,
		...params.pluginId ? { pluginId: params.pluginId } : {},
		workspaceDir: params.workspaceDir
	}), params.channelId, params.supports);
}
async function resolveInstallableChannelPlugin(params) {
	const supports = params.supports ?? (() => true);
	let nextCfg = params.cfg;
	const workspaceDir = resolveWorkspaceDir(nextCfg);
	const catalogEntry = (params.rawChannel ? resolveCatalogChannelEntry(params.rawChannel, nextCfg) : void 0) ?? (params.channelId ? getTrustedChannelPluginCatalogEntry(params.channelId, {
		cfg: nextCfg,
		workspaceDir
	}) : void 0);
	const channelId = params.channelId ?? resolveResolvedChannelId({
		rawChannel: params.rawChannel,
		catalogEntry
	});
	if (!channelId) return {
		cfg: nextCfg,
		catalogEntry,
		configChanged: false,
		pluginInstalled: false
	};
	const existing = getChannelPlugin(channelId);
	if (existing) return {
		cfg: nextCfg,
		channelId,
		plugin: existing,
		catalogEntry,
		configChanged: false,
		pluginInstalled: false,
		supportsRequestedCapability: supports(existing)
	};
	const resolvedPluginId = catalogEntry?.pluginId;
	if (catalogEntry) {
		const scoped = loadScopedChannelPlugin({
			cfg: nextCfg,
			runtime: params.runtime,
			channelId,
			supports,
			pluginId: resolvedPluginId,
			workspaceDir
		});
		if (scoped) return {
			cfg: nextCfg,
			channelId,
			plugin: scoped,
			catalogEntry,
			configChanged: false,
			pluginInstalled: false,
			supportsRequestedCapability: supports(scoped)
		};
		if (params.allowInstall !== false) {
			const installResult = await ensureChannelSetupPluginInstalled({
				cfg: nextCfg,
				entry: catalogEntry,
				prompter: params.prompter ?? createClackPrompter(),
				runtime: params.runtime,
				workspaceDir
			});
			nextCfg = installResult.cfg;
			const installedPluginId = installResult.pluginId ?? resolvedPluginId;
			const installedPlugin = installResult.installed ? loadScopedChannelPlugin({
				cfg: nextCfg,
				runtime: params.runtime,
				channelId,
				supports,
				pluginId: installedPluginId,
				workspaceDir: resolveWorkspaceDir(nextCfg)
			}) : void 0;
			return {
				cfg: nextCfg,
				channelId,
				plugin: installedPlugin ?? existing,
				catalogEntry: installedPluginId && catalogEntry.pluginId !== installedPluginId ? {
					...catalogEntry,
					pluginId: installedPluginId
				} : catalogEntry,
				configChanged: nextCfg !== params.cfg,
				pluginInstalled: installResult.installed,
				supportsRequestedCapability: installedPlugin ? supports(installedPlugin) : void 0
			};
		}
	}
	return {
		cfg: nextCfg,
		channelId,
		plugin: existing,
		catalogEntry,
		configChanged: false,
		pluginInstalled: false
	};
}
//#endregion
export { resolveInstallableChannelPlugin as t };
