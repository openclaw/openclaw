import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { g as resolvePinnedHostnameWithPolicy } from "../../ssrf-D9lCgUAx.js";
import "../../text-runtime-FOsx_CPC.js";
import "../../ssrf-runtime-Cup62pw7.js";
//#region extensions/line/src/outbound-media.ts
const LINE_OUTBOUND_MEDIA_SSRF_POLICY = { allowPrivateNetwork: false };
async function validateLineMediaUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`LINE outbound media URL must be a valid URL: ${url}`);
	}
	if (parsed.protocol !== "https:") throw new Error(`LINE outbound media URL must use HTTPS: ${url}`);
	if (url.length > 2e3) throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
	await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY });
}
function isHttpsUrl(url) {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}
function detectLineMediaKindFromUrl(url) {
	try {
		const pathname = normalizeLowercaseStringOrEmpty(new URL(url).pathname);
		if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(pathname)) return "image";
		if (/\.(mp4|mov|m4v|webm)$/i.test(pathname)) return "video";
		if (/\.(mp3|m4a|aac|wav|ogg|oga)$/i.test(pathname)) return "audio";
	} catch {
		return;
	}
}
async function resolveLineOutboundMedia(mediaUrl, opts = {}) {
	const trimmedUrl = mediaUrl.trim();
	if (isHttpsUrl(trimmedUrl)) {
		await validateLineMediaUrl(trimmedUrl);
		const previewImageUrl = opts.previewImageUrl?.trim();
		if (previewImageUrl) await validateLineMediaUrl(previewImageUrl);
		return {
			mediaUrl: trimmedUrl,
			mediaKind: opts.mediaKind ?? (typeof opts.durationMs === "number" ? "audio" : void 0) ?? (opts.trackingId?.trim() ? "video" : void 0) ?? detectLineMediaKindFromUrl(trimmedUrl) ?? "image",
			...previewImageUrl ? { previewImageUrl } : {},
			...typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {},
			...opts.trackingId ? { trackingId: opts.trackingId } : {}
		};
	}
	try {
		if (new URL(trimmedUrl).protocol !== "https:") throw new Error(`LINE outbound media URL must use HTTPS: ${trimmedUrl}`);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("LINE outbound")) throw e;
	}
	throw new Error("LINE outbound media currently requires a public HTTPS URL");
}
//#endregion
export { validateLineMediaUrl as n, resolveLineOutboundMedia as t };
