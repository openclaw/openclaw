import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { i as fetchProviderDownloadResponse } from "./shared-D8kCtbT2.js";
//#region src/music-generation/provider-assets.ts
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizeSpecificAudioMimeType(value) {
	const mimeType = normalizeOptionalString(value)?.split(";")[0]?.trim().toLowerCase();
	if (!mimeType || mimeType === "application/octet-stream" || mimeType === "binary/octet-stream") return;
	return mimeType;
}
function pushGeneratedMusicFileCandidate(candidates, value) {
	if (typeof value === "string") {
		const url = normalizeOptionalString(value);
		if (url) candidates.push({ url });
		return;
	}
	if (!isRecord(value)) return;
	const url = normalizeOptionalString(value.url);
	if (!url) return;
	candidates.push({
		url,
		...normalizeOptionalString(value.content_type) ? { mimeType: normalizeOptionalString(value.content_type) } : {},
		...normalizeOptionalString(value.file_name) ? { fileName: normalizeOptionalString(value.file_name) } : {}
	});
}
function extractGeneratedMusicFileCandidates(payload, keys = ["audio", "audio_file"]) {
	if (!isRecord(payload)) return [];
	const candidates = [];
	for (const key of keys) pushGeneratedMusicFileCandidate(candidates, payload[key]);
	return candidates;
}
function generatedMusicAssetFromBase64(params) {
	const ext = extensionForMime(params.mimeType)?.replace(/^\./u, "") || "mp3";
	return {
		buffer: Buffer.from(params.base64, "base64"),
		mimeType: params.mimeType,
		fileName: params.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`
	};
}
async function downloadGeneratedMusicAsset(params) {
	const response = await fetchProviderDownloadResponse({
		url: params.candidate.url,
		init: { method: "GET" },
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		provider: params.provider,
		requestFailedMessage: params.requestFailedMessage
	});
	const mimeType = normalizeSpecificAudioMimeType(response.headers.get("content-type")) ?? normalizeSpecificAudioMimeType(params.candidate.mimeType) ?? "audio/mpeg";
	const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
	return {
		buffer: Buffer.from(await response.arrayBuffer()),
		mimeType,
		fileName: params.candidate.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`,
		metadata: { url: params.candidate.url }
	};
}
//#endregion
export { extractGeneratedMusicFileCandidates as n, generatedMusicAssetFromBase64 as r, downloadGeneratedMusicAsset as t };
