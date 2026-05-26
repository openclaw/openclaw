import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeChatChannelId } from "./ids-DFu3Ho6n.js";
import "./chat-meta-DTmQp8Tt.js";
import { n as findRegisteredChannelPluginEntryById, r as listRegisteredChannelPluginEntries, t as findRegisteredChannelPluginEntry } from "./registry-lookup-DrgM4VYY.js";
//#region src/channels/registry.ts
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
