import { t as loadWebMedia } from "./web-media-BmMPbe_h.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-B8yVliVc.js";
import "./web-media-BG3zhclb.js";
//#region src/plugin-sdk/outbound-media.ts
/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
	return await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
		maxBytes: options.maxBytes,
		mediaAccess: options.mediaAccess,
		mediaLocalRoots: options.mediaLocalRoots,
		mediaReadFile: options.mediaReadFile,
		proxyUrl: options.proxyUrl,
		fetchImpl: options.fetchImpl,
		requestInit: options.requestInit,
		trustExplicitProxyDns: options.trustExplicitProxyDns
	}));
}
//#endregion
export { loadOutboundMediaFromUrl as t };
