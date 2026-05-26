import "./local-roots-Pi6a9oaK.js";
//#region src/plugin-sdk/agent-media-payload.ts
/** Convert outbound media descriptors into the legacy agent payload field layout. */
function buildAgentMediaPayload(mediaList) {
	const first = mediaList[0];
	const mediaPaths = mediaList.map((media) => media.path);
	const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean);
	return {
		MediaPath: first?.path,
		MediaType: first?.contentType ?? void 0,
		MediaUrl: first?.path,
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaUrls: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0
	};
}
//#endregion
export { buildAgentMediaPayload as t };
