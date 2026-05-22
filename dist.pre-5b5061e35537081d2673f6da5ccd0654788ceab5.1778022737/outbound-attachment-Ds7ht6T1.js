import { l as saveMediaBuffer } from "./store-CuaIMlC4.js";
import { t as loadWebMedia } from "./web-media-Cd1lDznL.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-XZ7Ay721.js";
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
