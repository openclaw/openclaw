import { n as normalizeMediaProviderId } from "./provider-id-BETgOIvU.js";
//#region src/media-understanding/entry-capabilities.ts
const MEDIA_CAPABILITIES = [
	"audio",
	"image",
	"video"
];
function isMediaCapability(value) {
	return typeof value === "string" && MEDIA_CAPABILITIES.includes(value);
}
function resolveEntryType(entry) {
	return entry.type ?? (entry.command ? "cli" : "provider");
}
function resolveConfiguredMediaEntryCapabilities(entry) {
	if (!Array.isArray(entry.capabilities)) return;
	const capabilities = entry.capabilities.filter(isMediaCapability);
	return capabilities.length > 0 ? capabilities : void 0;
}
function resolveEffectiveMediaEntryCapabilities(params) {
	const configured = resolveConfiguredMediaEntryCapabilities(params.entry);
	if (configured) return configured;
	if (params.source !== "shared") return;
	if (resolveEntryType(params.entry) === "cli") return;
	const providerId = normalizeMediaProviderId(params.entry.provider ?? "");
	if (!providerId) return;
	return params.providerRegistry.get(providerId)?.capabilities;
}
function matchesMediaEntryCapability(params) {
	const capabilities = resolveEffectiveMediaEntryCapabilities(params);
	if (!capabilities || capabilities.length === 0) return params.source === "capability";
	return capabilities.includes(params.capability);
}
//#endregion
export { resolveConfiguredMediaEntryCapabilities as n, resolveEffectiveMediaEntryCapabilities as r, matchesMediaEntryCapability as t };
