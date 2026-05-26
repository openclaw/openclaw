//#region src/channels/plugins/exposure.ts
function resolveChannelExposure(meta) {
	return {
		configured: meta.exposure?.configured ?? meta.showConfigured ?? true,
		setup: meta.exposure?.setup ?? meta.showInSetup ?? true,
		docs: meta.exposure?.docs ?? true
	};
}
function isChannelVisibleInConfiguredLists(meta) {
	return resolveChannelExposure(meta).configured;
}
function isChannelVisibleInSetup(meta) {
	return resolveChannelExposure(meta).setup;
}
//#endregion
//#region src/channels/plugins/channel-meta.ts
function buildManifestChannelMeta(params) {
	const hasArrayField = (value) => params.arrayFieldMode === "defined" ? value !== void 0 : Boolean(value?.length);
	const hasSelectionDocsPrefix = params.selectionDocsPrefixMode === "defined" ? params.channel.selectionDocsPrefix !== void 0 : Boolean(params.channel.selectionDocsPrefix);
	return {
		id: params.id,
		label: params.label,
		selectionLabel: params.selectionLabel,
		docsPath: params.docsPath,
		docsLabel: params.docsLabel,
		blurb: params.blurb,
		...hasArrayField(params.channel.aliases) ? { aliases: params.channel.aliases } : {},
		...params.channel.order !== void 0 ? { order: params.channel.order } : {},
		...hasSelectionDocsPrefix ? { selectionDocsPrefix: params.channel.selectionDocsPrefix } : {},
		...params.channel.selectionDocsOmitLabel !== void 0 ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel } : {},
		...hasArrayField(params.channel.selectionExtras) ? { selectionExtras: params.channel.selectionExtras } : {},
		...params.detailLabel ? { detailLabel: params.detailLabel } : {},
		...params.systemImage ? { systemImage: params.systemImage } : {},
		...params.channel.markdownCapable !== void 0 ? { markdownCapable: params.channel.markdownCapable } : {},
		exposure: resolveChannelExposure(params.channel),
		...params.channel.quickstartAllowFrom !== void 0 ? { quickstartAllowFrom: params.channel.quickstartAllowFrom } : {},
		...params.channel.forceAccountBinding !== void 0 ? { forceAccountBinding: params.channel.forceAccountBinding } : {},
		...params.channel.preferSessionLookupForAnnounceTarget !== void 0 ? { preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget } : {},
		...hasArrayField(params.channel.preferOver) ? { preferOver: params.channel.preferOver } : {}
	};
}
//#endregion
export { isChannelVisibleInConfiguredLists as n, isChannelVisibleInSetup as r, buildManifestChannelMeta as t };
