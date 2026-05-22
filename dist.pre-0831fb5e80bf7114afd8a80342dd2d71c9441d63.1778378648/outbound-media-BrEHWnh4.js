import { t as loadWebMedia } from "./web-media-B_vay4PO.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-VZvOFR_s.js";
import "./web-media-4gBxtywO.js";
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
