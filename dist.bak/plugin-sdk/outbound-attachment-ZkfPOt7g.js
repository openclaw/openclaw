import { a as loadWebMedia } from "./ir-DSH0voN3.js";
import { i as saveMediaBuffer } from "./store-VrLJabdN.js";

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