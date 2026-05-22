import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-D-0WKaTm.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import "./provider-http-CrELkUFA.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
//#region extensions/anthropic-vertex/region.ts
const ANTHROPIC_VERTEX_DEFAULT_REGION = "global";
const ANTHROPIC_VERTEX_REGION_RE = /^[a-z0-9-]+$/;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
function normalizeOptionalSecretInput(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function resolveAnthropicVertexRegion(env = process.env) {
	const region = normalizeOptionalSecretInput(env.GOOGLE_CLOUD_LOCATION) || normalizeOptionalSecretInput(env.CLOUD_ML_REGION);
	return region && ANTHROPIC_VERTEX_REGION_RE.test(region) ? region : ANTHROPIC_VERTEX_DEFAULT_REGION;
}
function resolveAnthropicVertexProjectId(env = process.env) {
	return normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_PROJECT_ID) || normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT) || normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT_ID) || resolveAnthropicVertexProjectIdFromAdc(env);
}
function resolveAnthropicVertexRegionFromBaseUrl(baseUrl) {
	const endpoint = resolveProviderEndpoint(baseUrl);
	return endpoint.endpointClass === "google-vertex" ? endpoint.googleVertexRegion : void 0;
}
function resolveAnthropicVertexClientRegion(params) {
	return resolveAnthropicVertexRegionFromBaseUrl(params?.baseUrl) || resolveAnthropicVertexRegion(params?.env);
}
function hasAnthropicVertexMetadataServerAdc(env = process.env) {
	const explicitMetadataOptIn = normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
	return explicitMetadataOptIn === "1" || normalizeLowercaseStringOrEmpty(explicitMetadataOptIn) === "true";
}
function resolveAnthropicVertexHomeDir(env = process.env) {
	return normalizeOptionalSecretInput(env.HOME) || normalizeOptionalSecretInput(env.USERPROFILE) || homedir();
}
function resolveAnthropicVertexDefaultAdcPath(env = process.env) {
	return platform() === "win32" ? join(normalizeOptionalSecretInput(env.APPDATA) ?? join(resolveAnthropicVertexHomeDir(env), "AppData", "Roaming"), "gcloud", "application_default_credentials.json") : join(resolveAnthropicVertexHomeDir(env), ".config", "gcloud", "application_default_credentials.json");
}
function resolveAnthropicVertexAdcCredentialsPathCandidate(env = process.env) {
	const explicit = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
	if (explicit) return explicit;
	return resolveAnthropicVertexDefaultAdcPath(env);
}
function canReadAnthropicVertexAdc(env = process.env) {
	const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
	if (!credentialsPath) return false;
	try {
		readFileSync(credentialsPath, "utf8");
		return true;
	} catch {
		return false;
	}
}
function resolveAnthropicVertexProjectIdFromAdc(env = process.env) {
	const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
	if (!credentialsPath) return;
	try {
		const parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
		return normalizeOptionalSecretInput(parsed.project_id) || normalizeOptionalSecretInput(parsed.quota_project_id);
	} catch {
		return;
	}
}
function hasAnthropicVertexCredentials(env = process.env) {
	return hasAnthropicVertexMetadataServerAdc(env) || canReadAnthropicVertexAdc(env);
}
function hasAnthropicVertexAvailableAuth(env = process.env) {
	return hasAnthropicVertexCredentials(env);
}
function resolveAnthropicVertexConfigApiKey(env = process.env) {
	return hasAnthropicVertexAvailableAuth(env) ? GCP_VERTEX_CREDENTIALS_MARKER : void 0;
}
//#endregion
export { resolveAnthropicVertexProjectId as a, resolveAnthropicVertexConfigApiKey as i, hasAnthropicVertexCredentials as n, resolveAnthropicVertexRegion as o, resolveAnthropicVertexClientRegion as r, resolveAnthropicVertexRegionFromBaseUrl as s, hasAnthropicVertexAvailableAuth as t };
