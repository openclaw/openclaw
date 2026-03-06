//#region src/media/load-options.ts
function resolveOutboundMediaLocalRoots(mediaLocalRoots) {
	return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : void 0;
}
function buildOutboundMediaLoadOptions(params = {}) {
	const localRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
	return {
		...params.maxBytes !== void 0 ? { maxBytes: params.maxBytes } : {},
		...localRoots ? { localRoots } : {}
	};
}

//#endregion
export { buildOutboundMediaLoadOptions as t };