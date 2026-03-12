import { r as saveMediaBuffer } from "./store-D3mH9Iqw.js";
import { a as loadWebMedia } from "./ir-BdlSx5oD.js";

//#region src/media/outbound-attachment.ts
async function resolveOutboundAttachmentFromUrl(mediaUrl, maxBytes, options) {
	const media = await loadWebMedia(mediaUrl, {
		maxBytes,
		localRoots: options?.localRoots
	});
	const saved = await saveMediaBuffer(media.buffer, media.contentType ?? void 0, "outbound", maxBytes);
	return {
		path: saved.path,
		contentType: saved.contentType
	};
}

//#endregion
export { resolveOutboundAttachmentFromUrl as t };