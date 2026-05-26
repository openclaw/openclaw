import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { r as isChannelVisibleInSetup } from "./channel-meta-COEgfCjE.js";
import { n as listChatChannels } from "./chat-meta-2H4wOcrq.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { m as normalizeChannelMeta } from "./bundled-0oTAwz0N.js";
import { n as isStaticallyChannelConfigured } from "./channel-configured-B6BYuKoD.js";
import { t as listManifestChannelContributionIds } from "./manifest-contribution-ids-tozuTTjv.js";
import { n as listSetupDiscoveryChannelPluginCatalogEntries, r as listTrustedChannelPluginCatalogEntries } from "./trusted-catalog-ax5bRVns.js";
//#region src/commands/channel-setup/discovery.ts
function shouldShowChannelInSetup(meta) {
	return isChannelVisibleInSetup(meta);
}
function resolveWorkspaceDir(cfg, workspaceDir) {
	return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
function listManifestInstalledChannelIds(params) {
	const resolvedConfig = applyPluginAutoEnable({
		config: params.cfg,
		env: params.env ?? process.env
	}).config;
	const workspaceDir = resolveWorkspaceDir(resolvedConfig, params.workspaceDir);
	return new Set(listManifestChannelContributionIds({
		config: resolvedConfig,
		workspaceDir,
		env: params.env ?? process.env
	}).map((channelId) => channelId));
}
function isCatalogChannelInstalled(params) {
	return listManifestInstalledChannelIds(params).has(params.entry.id);
}
function resolveChannelSetupEntries(params) {
	const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
	const manifestInstalledIds = listManifestInstalledChannelIds({
		cfg: params.cfg,
		workspaceDir,
		env: params.env
	});
	const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
	const installedCatalogEntriesSource = listTrustedChannelPluginCatalogEntries({
		cfg: params.cfg,
		workspaceDir,
		env: params.env
	});
	const installableCatalogEntriesSource = listSetupDiscoveryChannelPluginCatalogEntries({
		cfg: params.cfg,
		workspaceDir,
		env: params.env
	});
	const installedCatalogEntries = installedCatalogEntriesSource.filter((entry) => !installedPluginIds.has(entry.id) && manifestInstalledIds.has(entry.id) && shouldShowChannelInSetup(entry.meta)).map((entry) => Object.assign({}, entry, { meta: normalizeChannelMeta({
		id: entry.id,
		meta: entry.meta
	}) }));
	const installableCatalogEntries = installableCatalogEntriesSource.filter((entry) => !installedPluginIds.has(entry.id) && !manifestInstalledIds.has(entry.id) && !isStaticallyChannelConfigured(params.cfg, entry.id, params.env ?? process.env) && shouldShowChannelInSetup(entry.meta)).map((entry) => Object.assign({}, entry, { meta: normalizeChannelMeta({
		id: entry.id,
		meta: entry.meta
	}) }));
	const metaById = /* @__PURE__ */ new Map();
	for (const meta of listChatChannels()) metaById.set(meta.id, normalizeChannelMeta({
		id: meta.id,
		meta
	}));
	for (const plugin of params.installedPlugins) metaById.set(plugin.id, normalizeChannelMeta({
		id: plugin.id,
		meta: plugin.meta,
		existing: metaById.get(plugin.id)
	}));
	for (const entry of installedCatalogEntries) if (!metaById.has(entry.id)) metaById.set(entry.id, normalizeChannelMeta({
		id: entry.id,
		meta: entry.meta,
		existing: metaById.get(entry.id)
	}));
	for (const entry of installableCatalogEntries) if (!metaById.has(entry.id)) metaById.set(entry.id, normalizeChannelMeta({
		id: entry.id,
		meta: entry.meta,
		existing: metaById.get(entry.id)
	}));
	return {
		entries: Array.from(metaById, ([id, meta]) => ({
			id,
			meta
		})).filter((entry) => shouldShowChannelInSetup(entry.meta)),
		installedCatalogEntries,
		installableCatalogEntries,
		installedCatalogById: new Map(installedCatalogEntries.map((entry) => [entry.id, entry])),
		installableCatalogById: new Map(installableCatalogEntries.map((entry) => [entry.id, entry]))
	};
}
//#endregion
export { shouldShowChannelInSetup as i, listManifestInstalledChannelIds as n, resolveChannelSetupEntries as r, isCatalogChannelInstalled as t };
