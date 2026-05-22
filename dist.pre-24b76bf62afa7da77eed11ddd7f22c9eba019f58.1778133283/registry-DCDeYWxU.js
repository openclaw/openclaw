import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { r as normalizeChatChannelId } from "./ids-PHiL43bp.js";
import "./chat-meta-YaI828S4.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-BUHEIolZ.js";
//#region src/channels/registry.ts
function listRegisteredChannelPluginEntries() {
	const channelRegistry = getActivePluginChannelRegistryFromState();
	if (channelRegistry && channelRegistry.channels && channelRegistry.channels.length > 0) return channelRegistry.channels;
	return [];
}
function findRegisteredChannelPluginEntry(normalizedKey) {
	return listRegisteredChannelPluginEntries().find((entry) => {
		const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
		if (id && id === normalizedKey) return true;
		return (entry.plugin.meta?.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === normalizedKey);
	});
}
function findRegisteredChannelPluginEntryById(id) {
	const normalizedId = normalizeOptionalLowercaseString(id);
	if (!normalizedId) return;
	return listRegisteredChannelPluginEntries().find((entry) => normalizeOptionalLowercaseString(entry.plugin.id) === normalizedId);
}
function normalizeChannelId(raw) {
	return normalizeChatChannelId(raw);
}
function normalizeAnyChannelId(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return null;
	return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
function listRegisteredChannelPluginIds() {
	return listRegisteredChannelPluginEntries().flatMap((entry) => {
		const id = normalizeOptionalString(entry.plugin.id);
		return id ? [id] : [];
	});
}
function getRegisteredChannelPluginMeta(id) {
	return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}
function formatChannelPrimerLine(meta) {
	return `${meta.label}: ${meta.blurb}`;
}
function formatChannelSelectionLine(meta, docsLink) {
	const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
	const docsLabel = meta.docsLabel ?? meta.id;
	const docs = meta.selectionDocsOmitLabel ? docsLink(meta.docsPath) : docsLink(meta.docsPath, docsLabel);
	const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
	return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
//#endregion
export { normalizeAnyChannelId as a, listRegisteredChannelPluginIds as i, formatChannelSelectionLine as n, normalizeChannelId as o, getRegisteredChannelPluginMeta as r, formatChannelPrimerLine as t };
