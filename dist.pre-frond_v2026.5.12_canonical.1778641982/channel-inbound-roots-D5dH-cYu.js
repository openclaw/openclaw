import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-DAC6GNWm.js";
//#region src/media/channel-inbound-roots.ts
const mediaContractApiByChannel = /* @__PURE__ */ new Map();
function loadChannelMediaContractApi(channelId, resolver) {
	if (mediaContractApiByChannel.has(channelId)) {
		const cached = mediaContractApiByChannel.get(channelId);
		return cached && typeof cached[resolver] === "function" ? cached : void 0;
	}
	try {
		const loaded = loadBundledPluginPublicArtifactModuleSync({
			dirName: channelId,
			artifactBasename: "media-contract-api.js"
		});
		mediaContractApiByChannel.set(channelId, loaded);
		if (typeof loaded[resolver] === "function") return loaded;
		return;
	} catch (error) {
		if (!(error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface "))) throw error;
	}
	mediaContractApiByChannel.set(channelId, null);
}
function findChannelMediaContractApi(channelId, resolver) {
	const normalized = normalizeOptionalLowercaseString(channelId);
	if (!normalized) return;
	return loadChannelMediaContractApi(normalized, resolver);
}
function resolveChannelInboundAttachmentRoots(params) {
	const contractApi = findChannelMediaContractApi(params.ctx.Surface ?? params.ctx.Provider, "resolveInboundAttachmentRoots");
	if (contractApi?.resolveInboundAttachmentRoots) return contractApi.resolveInboundAttachmentRoots({
		cfg: params.cfg,
		accountId: params.ctx.AccountId
	});
}
function resolveChannelRemoteInboundAttachmentRoots(params) {
	const contractApi = findChannelMediaContractApi(params.ctx.Surface ?? params.ctx.Provider, "resolveRemoteInboundAttachmentRoots");
	if (contractApi?.resolveRemoteInboundAttachmentRoots) return contractApi.resolveRemoteInboundAttachmentRoots({
		cfg: params.cfg,
		accountId: params.ctx.AccountId
	});
}
//#endregion
export { resolveChannelRemoteInboundAttachmentRoots as n, resolveChannelInboundAttachmentRoots as t };
