import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-LnfEFXDj.js";
//#region src/media/outbound-attachment.ts
async function resolveOutboundAttachmentFromUrl(mediaUrl, maxBytes, options) {
	const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
		maxBytes,
		mediaAccess: options?.mediaAccess,
		mediaLocalRoots: options?.localRoots,
		mediaReadFile: options?.readFile
	}));
	const saved = await saveMediaBuffer(media.buffer, media.contentType ?? void 0, "outbound", maxBytes, media.fileName);
	return {
		path: saved.path,
		contentType: saved.contentType
	};
}
//#endregion
export { resolveOutboundAttachmentFromUrl as t };
