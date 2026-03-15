//#region src/channels/plugins/media-payload.ts
function buildMediaPayload(mediaList, opts) {
	const first = mediaList[0];
	const mediaPaths = mediaList.map((media) => media.path);
	const rawMediaTypes = mediaList.map((media) => media.contentType ?? "");
	const mediaTypes = opts?.preserveMediaTypeCardinality ? rawMediaTypes : rawMediaTypes.filter((value) => Boolean(value));
	return {
		MediaPath: first?.path,
		MediaType: first?.contentType,
		MediaUrl: first?.path,
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaUrls: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0
	};
}
//#endregion
export { buildMediaPayload as t };
