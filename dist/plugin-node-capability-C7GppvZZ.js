import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { randomBytes } from "node:crypto";
//#region src/gateway/plugin-node-capability.ts
const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const PLUGIN_NODE_CAPABILITY_QUERY_PARAM = "oc_cap";
const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS = 10 * 6e4;
function indexPluginNodeCapabilitySurfaces(surfaces) {
	const indexed = {};
	for (const entry of surfaces) {
		const surface = normalizeSurface(entry.surface);
		if (!surface) continue;
		const existing = indexed[surface];
		const next = {
			...entry,
			surface
		};
		if (!existing || resolvePluginNodeCapabilityTtlMs(next) < resolvePluginNodeCapabilityTtlMs(existing)) indexed[surface] = next;
	}
	return indexed;
}
function normalizeCapability(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeSurface(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function resolvePluginNodeCapabilityStorageKey(surface) {
	const normalizedSurface = normalizeSurface(surface.surface);
	if (!normalizedSurface) return;
	const scopeKey = surface.scopeKey?.trim();
	return scopeKey ? `${normalizedSurface}\0${scopeKey}` : normalizedSurface;
}
function resolvePluginNodeCapabilityTtlMs(surface) {
	return surface.ttlMs && surface.ttlMs > 0 ? surface.ttlMs : DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;
}
function mintPluginNodeCapabilityToken() {
	return randomBytes(18).toString("base64url");
}
function buildPluginNodeCapabilityScopedHostUrl(baseUrl, capability) {
	const normalizedCapability = normalizeCapability(capability);
	if (!normalizedCapability) return;
	try {
		const url = new URL(baseUrl);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${`${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`}`;
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return;
	}
}
function replacePluginNodeCapabilityInScopedHostUrl(scopedUrl, capability) {
	const normalizedCapability = normalizeCapability(capability);
	if (!normalizedCapability) return;
	try {
		const url = new URL(scopedUrl);
		const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
		const markerStart = url.pathname.indexOf(prefix);
		if (markerStart < 0) return buildPluginNodeCapabilityScopedHostUrl(scopedUrl, normalizedCapability);
		const capabilityStart = markerStart + prefix.length;
		const nextSlashIndex = url.pathname.indexOf("/", capabilityStart);
		const capabilityEnd = nextSlashIndex >= 0 ? nextSlashIndex : url.pathname.length;
		if (capabilityEnd <= capabilityStart) return;
		url.pathname = url.pathname.slice(0, capabilityStart) + encodeURIComponent(normalizedCapability) + url.pathname.slice(capabilityEnd);
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return;
	}
}
function normalizePluginNodeCapabilityScopedUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl, "http://localhost");
	} catch {
		return {
			pathname: "/",
			scopedPath: false,
			malformedScopedPath: true
		};
	}
	const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
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
				if (!url.searchParams.has(PLUGIN_NODE_CAPABILITY_QUERY_PARAM)) url.searchParams.set(PLUGIN_NODE_CAPABILITY_QUERY_PARAM, capabilityFromPath);
				rewrittenUrl = `${url.pathname}${url.search}`;
			}
		}
	}
	const capability = capabilityFromPath ?? normalizeCapability(url.searchParams.get(PLUGIN_NODE_CAPABILITY_QUERY_PARAM));
	return {
		pathname: url.pathname,
		capability,
		rewrittenUrl,
		scopedPath,
		malformedScopedPath
	};
}
function setClientPluginNodeCapability(params) {
	const surface = normalizeSurface(params.surface.surface);
	const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
	if (!surface || !storageKey) return;
	params.client.pluginNodeCapabilities ??= {};
	params.client.pluginNodeCapabilities[storageKey] = {
		capability: params.capability,
		expiresAtMs: params.expiresAtMs
	};
}
function refreshClientPluginNodeCapability(params) {
	const surface = normalizeSurface(params.surface.surface);
	if (!surface) return;
	const existingUrl = params.client.pluginSurfaceUrls?.[surface];
	if (!existingUrl) return;
	const capabilitySurface = params.client.pluginNodeCapabilitySurfaces?.[surface] ?? params.surface;
	const capability = mintPluginNodeCapabilityToken();
	const expiresAtMs = (params.nowMs ?? Date.now()) + resolvePluginNodeCapabilityTtlMs(capabilitySurface);
	const scopedUrl = replacePluginNodeCapabilityInScopedHostUrl(existingUrl, capability);
	if (!scopedUrl) return;
	params.client.pluginSurfaceUrls ??= {};
	params.client.pluginSurfaceUrls[surface] = scopedUrl;
	setClientPluginNodeCapability({
		client: params.client,
		surface: capabilitySurface,
		capability,
		expiresAtMs
	});
	return {
		surface,
		capability,
		expiresAtMs,
		scopedUrl
	};
}
function hasAuthorizedPluginNodeCapability(params) {
	const surface = normalizeSurface(params.surface.surface);
	const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
	if (!surface || !storageKey) return false;
	const nowMs = params.nowMs ?? Date.now();
	const ttlMs = resolvePluginNodeCapabilityTtlMs(params.surface);
	for (const client of params.clients) {
		const entry = client.pluginNodeCapabilities?.[storageKey];
		if (!entry || entry.expiresAtMs <= nowMs) continue;
		if (safeEqualSecret(entry.capability, params.capability)) {
			entry.expiresAtMs = nowMs + ttlMs;
			return true;
		}
	}
	return false;
}
//#endregion
export { indexPluginNodeCapabilitySurfaces as a, refreshClientPluginNodeCapability as c, hasAuthorizedPluginNodeCapability as i, resolvePluginNodeCapabilityTtlMs as l, PLUGIN_NODE_CAPABILITY_PATH_PREFIX as n, mintPluginNodeCapabilityToken as o, buildPluginNodeCapabilityScopedHostUrl as r, normalizePluginNodeCapabilityScopedUrl as s, DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS as t, setClientPluginNodeCapability as u };
