import { y as buildCodexAppInventoryCacheKey } from "./thread-lifecycle-ICclp34e.js";
import { f as resolveCodexAppServerHomeDir } from "./shared-client-BGXGt_Pl.js";
import { createHash } from "node:crypto";
//#region extensions/codex/src/app-server/plugin-app-cache-key.ts
function buildCodexPluginAppCacheKey(params) {
	return buildCodexAppInventoryCacheKey({
		codexHome: resolveCodexPluginAppCacheCodexHome(params.appServer, params.agentDir),
		endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
		authProfileId: params.authProfileId,
		accountId: params.accountId,
		envApiKeyFingerprint: params.envApiKeyFingerprint,
		appServerVersion: params.appServerVersion
	});
}
function resolveCodexPluginAppCacheEndpoint(appServer) {
	return JSON.stringify({
		transport: appServer.start.transport,
		command: appServer.start.command,
		args: appServer.start.args,
		url: appServer.start.url ?? null,
		credentialFingerprint: fingerprintCodexPluginAppCacheCredentials(appServer.start)
	});
}
function resolveCodexPluginAppCacheCodexHome(appServer, agentDir) {
	const configuredCodexHome = appServer.start.env?.CODEX_HOME?.trim();
	if (configuredCodexHome) return configuredCodexHome;
	return appServer.start.transport === "stdio" && agentDir ? resolveCodexAppServerHomeDir(agentDir) : void 0;
}
function fingerprintCodexPluginAppCacheCredentials(startOptions) {
	const authToken = startOptions.authToken ?? "";
	const headers = Object.entries(startOptions.headers).map(([key, value]) => [key.toLowerCase(), value]).toSorted(([left], [right]) => left.localeCompare(right));
	if (!authToken && headers.length === 0) return null;
	const hash = createHash("sha256");
	hash.update("openclaw:codex:plugin-app-cache-credentials:v1");
	hash.update("\0");
	hash.update(authToken);
	for (const [key, value] of headers) {
		hash.update("\0");
		hash.update(key);
		hash.update("\0");
		hash.update(value);
	}
	return `sha256:${hash.digest("hex")}`;
}
//#endregion
export { buildCodexPluginAppCacheKey as t };
