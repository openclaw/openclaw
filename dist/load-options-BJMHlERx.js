//#region src/media/load-options.ts
function resolveOutboundMediaLocalRoots(mediaLocalRoots) {
	if (mediaLocalRoots === "any") return mediaLocalRoots;
	return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : void 0;
}
function resolveOutboundMediaAccess(params = {}) {
	const resolvedLocalRoots = resolveOutboundMediaLocalRoots(params.mediaAccess?.localRoots ?? params.mediaLocalRoots);
	const localRoots = resolvedLocalRoots === "any" ? void 0 : resolvedLocalRoots;
	const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
	const workspaceDir = params.mediaAccess?.workspaceDir;
	if (!localRoots && !readFile && !workspaceDir) return;
	return {
		...localRoots ? { localRoots } : {},
		...readFile ? { readFile } : {},
		...workspaceDir ? { workspaceDir } : {}
	};
}
function buildOutboundMediaLoadOptions(params = {}) {
	const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
	const mediaAccess = resolveOutboundMediaAccess({
		mediaAccess: params.mediaAccess,
		mediaLocalRoots: explicitLocalRoots === "any" ? void 0 : explicitLocalRoots,
		mediaReadFile: params.mediaAccess?.readFile ? void 0 : params.mediaReadFile
	});
	const workspaceDir = mediaAccess?.workspaceDir ?? params.workspaceDir;
	const readFile = mediaAccess?.readFile ?? params.mediaReadFile;
	const localRoots = mediaAccess?.localRoots ?? explicitLocalRoots;
	if (readFile) {
		if (!localRoots) throw new Error("Host media read requires explicit localRoots. Pass mediaAccess.localRoots or opt in with localRoots: \"any\".");
		return {
			...params.maxBytes !== void 0 ? { maxBytes: params.maxBytes } : {},
			localRoots,
			readFile,
			...params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
			...params.proxyUrl ? { proxyUrl: params.proxyUrl } : {},
			...params.requestInit ? { requestInit: params.requestInit } : {},
			...params.trustExplicitProxyDns !== void 0 ? { trustExplicitProxyDns: params.trustExplicitProxyDns } : {},
			hostReadCapability: true,
			...params.optimizeImages !== void 0 ? { optimizeImages: params.optimizeImages } : {},
			...workspaceDir ? { workspaceDir } : {}
		};
	}
	return {
		...params.maxBytes !== void 0 ? { maxBytes: params.maxBytes } : {},
		...localRoots ? { localRoots } : {},
		...params.proxyUrl ? { proxyUrl: params.proxyUrl } : {},
		...params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
		...params.requestInit ? { requestInit: params.requestInit } : {},
		...params.trustExplicitProxyDns !== void 0 ? { trustExplicitProxyDns: params.trustExplicitProxyDns } : {},
		...params.optimizeImages !== void 0 ? { optimizeImages: params.optimizeImages } : {},
		...workspaceDir ? { workspaceDir } : {}
	};
}
//#endregion
export { resolveOutboundMediaAccess as n, resolveOutboundMediaLocalRoots as r, buildOutboundMediaLoadOptions as t };
