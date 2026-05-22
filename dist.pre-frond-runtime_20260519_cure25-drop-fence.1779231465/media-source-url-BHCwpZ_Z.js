//#region src/media/media-source-url.ts
const HTTP_URL_RE = /^https?:\/\//i;
const MXC_URL_RE = /^mxc:\/\//i;
function isPassThroughRemoteMediaSource(value) {
	const normalized = value?.trim() ?? "";
	return Boolean(normalized) && (HTTP_URL_RE.test(normalized) || MXC_URL_RE.test(normalized));
}
//#endregion
export { isPassThroughRemoteMediaSource as t };
