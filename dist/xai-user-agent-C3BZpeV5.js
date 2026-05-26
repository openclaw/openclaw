import { n as VERSION } from "./version-CQfgAE7_.js";
import "./agent-harness-runtime-CMvm9HY6.js";
//#region extensions/xai/src/xai-user-agent.ts
const ORIGINATOR = "openclaw";
const UNUSABLE_PACKAGE_VERSION = "0.0.0";
const FALLBACK_VERSION = "unknown";
function trimToUndefined(value) {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : void 0;
}
function resolveXaiUserAgentVersion() {
	const envVersion = trimToUndefined(process.env.OPENCLAW_VERSION);
	if (envVersion) return envVersion;
	const packageVersion = trimToUndefined(VERSION);
	if (packageVersion && packageVersion !== UNUSABLE_PACKAGE_VERSION) return packageVersion;
	return trimToUndefined(process.env.OPENCLAW_SERVICE_VERSION) ?? trimToUndefined(process.env.npm_package_version) ?? FALLBACK_VERSION;
}
function xaiUserAgent() {
	return `${ORIGINATOR}/${resolveXaiUserAgentVersion()}`;
}
const XAI_NATIVE_API_HOSTS = new Set(["api.x.ai"]);
function xaiUserAgentHeaderFor(baseUrl) {
	if (!baseUrl) return {};
	try {
		if (XAI_NATIVE_API_HOSTS.has(new URL(baseUrl).hostname)) return { "User-Agent": xaiUserAgent() };
	} catch {
		return {};
	}
	return {};
}
//#endregion
export { xaiUserAgentHeaderFor as n, xaiUserAgent as t };
