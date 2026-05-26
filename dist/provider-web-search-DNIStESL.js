import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import "./enable-DL58ncJE.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import "./common-E9YpX7pB.js";
import "./external-content-BWPoz0BU.js";
import "./web-shared-CYJpPo1M.js";
import "./web-search-provider-common-Dg4Eh9ob.js";
import { r as withStrictWebToolsEndpoint } from "./web-guarded-fetch-CK8ghWAC.js";
//#region src/agents/tools/web-search-citation-redirect.ts
const REDIRECT_TIMEOUT_MS = 5e3;
/**
* Resolve a citation redirect URL to its final destination using a HEAD request.
* Returns the original URL if resolution fails or times out.
*/
async function resolveCitationRedirectUrl(url) {
	try {
		return await withStrictWebToolsEndpoint({
			url,
			init: { method: "HEAD" },
			timeoutMs: REDIRECT_TIMEOUT_MS
		}, async ({ finalUrl }) => finalUrl || url);
	} catch {
		return url;
	}
}
//#endregion
//#region src/agents/tools/web-search-provider-credentials.ts
function resolveWebSearchProviderCredential(params) {
	const fromConfig = normalizeSecretInput(normalizeSecretInputString(params.credentialValue));
	if (fromConfig) return fromConfig;
	const credentialRef = resolveSecretInputRef({ value: params.credentialValue }).ref;
	if (credentialRef) {
		if (credentialRef.source !== "env") return;
		const fromEnvRef = normalizeSecretInput(process.env[credentialRef.id]);
		if (fromEnvRef) return fromEnvRef;
		return;
	}
	for (const envVar of params.envVars) {
		const fromEnv = normalizeSecretInput(process.env[envVar]);
		if (fromEnv) return fromEnv;
	}
}
//#endregion
//#region src/plugin-sdk/provider-web-search.ts
/**
* @deprecated Implement provider-owned `createTool(...)` directly on the
* returned WebSearchProviderPlugin instead of routing through core.
*/
function createPluginBackedWebSearchProvider(provider) {
	return {
		...provider,
		createTool: () => {
			throw new Error(`createPluginBackedWebSearchProvider(${provider.id}) is no longer supported. Define provider-owned createTool(...) directly in the extension's WebSearchProviderPlugin.`);
		}
	};
}
//#endregion
export { resolveWebSearchProviderCredential as n, resolveCitationRedirectUrl as r, createPluginBackedWebSearchProvider as t };
