import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as listBundledChannelCatalogEntries, n as CHAT_CHANNEL_ORDER } from "./ids-BE_yccbC.js";
import { t as buildManifestChannelMeta } from "./channel-meta-COEgfCjE.js";
//#region src/channels/chat-meta-shared.ts
const CHAT_CHANNEL_ID_SET = new Set(CHAT_CHANNEL_ORDER);
function toChatChannelMeta(params) {
	const label = normalizeOptionalString(params.channel.label);
	if (!label) throw new Error(`Missing label for bundled chat channel "${params.id}"`);
	return buildManifestChannelMeta({
		id: params.id,
		channel: params.channel,
		label,
		selectionLabel: normalizeOptionalString(params.channel.selectionLabel) || label,
		docsPath: normalizeOptionalString(params.channel.docsPath) || `/channels/${params.id}`,
		docsLabel: normalizeOptionalString(params.channel.docsLabel),
		blurb: normalizeOptionalString(params.channel.blurb) || "",
		detailLabel: normalizeOptionalString(params.channel.detailLabel),
		systemImage: normalizeOptionalString(params.channel.systemImage),
		arrayFieldMode: "non-empty",
		selectionDocsPrefixMode: "defined"
	});
}
function buildChatChannelMetaById() {
	const entries = /* @__PURE__ */ new Map();
	for (const entry of listBundledChannelCatalogEntries()) {
		const rawId = normalizeOptionalString(entry.id);
		if (!rawId || !CHAT_CHANNEL_ID_SET.has(rawId)) continue;
		const id = rawId;
		entries.set(id, toChatChannelMeta({
			id,
			channel: entry.channel
		}));
	}
	return Object.freeze(Object.fromEntries(entries));
}
//#endregion
//#region src/channels/chat-meta.ts
const CHAT_CHANNEL_META = buildChatChannelMetaById();
function listChatChannels() {
	return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}
function getChatChannelMeta(id) {
	return CHAT_CHANNEL_META[id];
}
//#endregion
export { listChatChannels as n, buildChatChannelMetaById as r, getChatChannelMeta as t };
