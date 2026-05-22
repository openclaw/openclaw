import { randomBytes } from "node:crypto";
//#region src/gateway/canvas-capability.ts
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const CANVAS_CAPABILITY_QUERY_PARAM = "oc_cap";
const CANVAS_CAPABILITY_TTL_MS = 10 * 6e4;
function normalizeCapability(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function mintCanvasCapabilityToken() {
	return randomBytes(18).toString("base64url");
}
function buildCanvasScopedHostUrl(baseUrl, capability) {
	const normalizedCapability = normalizeCapability(capability);
	if (!normalizedCapability) return;
	try {
		const url = new URL(baseUrl);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${`${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`}`;
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return;
	}
}
function normalizeCanvasScopedUrl(rawUrl) {
	const url = new URL(rawUrl, "http://localhost");
	const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/`;
	let scopedPath = false;
	let malformedScopedPath = false;
	let capabilityFromPath;
	let rewrittenUrl;
	if (url.pathname.startsWith(prefix)) {
		scopedPath = true;
		const remainder = url.pathname.slice(prefix.length);
		const slashIndex = remainder.indexOf("/");
		if (slashIndex <= 0) malformedScopedPath = true;
		else {
			const encodedCapability = remainder.slice(0, slashIndex);
			const canonicalPath = remainder.slice(slashIndex) || "/";
			let decoded;
			try {
				decoded = decodeURIComponent(encodedCapability);
			} catch {
				malformedScopedPath = true;
			}
			capabilityFromPath = normalizeCapability(decoded);
			if (!capabilityFromPath || !canonicalPath.startsWith("/")) malformedScopedPath = true;
			else {
				url.pathname = canonicalPath;
				if (!url.searchParams.has(CANVAS_CAPABILITY_QUERY_PARAM)) url.searchParams.set(CANVAS_CAPABILITY_QUERY_PARAM, capabilityFromPath);
				rewrittenUrl = `${url.pathname}${url.search}`;
			}
		}
	}
	const capability = capabilityFromPath ?? normalizeCapability(url.searchParams.get(CANVAS_CAPABILITY_QUERY_PARAM));
	return {
		pathname: url.pathname,
		capability,
		rewrittenUrl,
		scopedPath,
		malformedScopedPath
	};
}
//#endregion
export { normalizeCanvasScopedUrl as i, buildCanvasScopedHostUrl as n, mintCanvasCapabilityToken as r, CANVAS_CAPABILITY_TTL_MS as t };
