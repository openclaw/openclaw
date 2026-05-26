import { o as resolveEnvHttpProxyAgentOptions, s as resolveEnvHttpProxyUrl } from "./proxy-env-Cs0G_0hd.js";
import { n as getActiveManagedProxyTlsOptions, r as getActiveManagedProxyUrl } from "./active-proxy-state-BBaqWhZo.js";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
//#region src/infra/net/proxy/proxy-tls.ts
function normalizeOptionalPath(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function formatReadError(err) {
	return err instanceof Error ? err.message : String(err);
}
function isHttpsProxyUrl(value) {
	if (!value) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}
function resolveManagedProxyCaFile(params) {
	return normalizeOptionalPath(params.caFileOverride) ?? normalizeOptionalPath(params.config?.tls?.caFile);
}
function resolveManagedProxyCaFileForUrl(params) {
	if (!isHttpsProxyUrl(params.proxyUrl)) return;
	return resolveManagedProxyCaFile({
		config: params.config,
		caFileOverride: params.caFileOverride
	});
}
async function loadManagedProxyTlsOptions(caFile) {
	if (!caFile) return;
	try {
		return { ca: await readFile(caFile, "utf8") };
	} catch (err) {
		throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, { cause: err });
	}
}
function loadManagedProxyTlsOptionsSync(caFile) {
	if (!caFile) return;
	try {
		return { ca: readFileSync(caFile, "utf8") };
	} catch (err) {
		throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, { cause: err });
	}
}
//#endregion
//#region src/infra/net/proxy/managed-proxy-undici.ts
function isProxyTlsRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readProxyTlsRecord(options) {
	if (!options || !("proxyTls" in options)) return;
	return isProxyTlsRecord(options.proxyTls) ? options.proxyTls : void 0;
}
function readProxyUrlFromOptions(options) {
	if (!options) return;
	if ("uri" in options) {
		const uri = Reflect.get(options, "uri");
		return uri instanceof URL ? uri.href : typeof uri === "string" ? uri : void 0;
	}
	if ("httpsProxy" in options || "httpProxy" in options) {
		const httpsProxy = Reflect.get(options, "httpsProxy");
		const httpProxy = Reflect.get(options, "httpProxy");
		return typeof httpsProxy === "string" ? httpsProxy : typeof httpProxy === "string" ? httpProxy : void 0;
	}
}
function normalizeProxyUrl(value) {
	if (!value) return;
	try {
		return new URL(value).href;
	} catch {
		return;
	}
}
function resolveManagedProxyUrl(env = process.env) {
	const activeProxyUrl = getActiveManagedProxyUrl();
	if (activeProxyUrl) return activeProxyUrl.href;
	if (env["OPENCLAW_PROXY_ACTIVE"] !== "1") return;
	return normalizeProxyUrl(resolveEnvHttpProxyUrl("https", env));
}
function resolveActiveManagedProxyTlsOptions(params) {
	const env = params?.env ?? process.env;
	const managedProxyUrl = resolveManagedProxyUrl(env);
	const targetProxyUrl = normalizeProxyUrl(params?.proxyUrl ?? resolveEnvHttpProxyUrl("https", env));
	if (!managedProxyUrl || targetProxyUrl !== managedProxyUrl) return;
	const activeProxyTls = getActiveManagedProxyTlsOptions();
	if (activeProxyTls) return activeProxyTls;
	const proxyCaFile = resolveManagedProxyCaFileForUrl({
		proxyUrl: managedProxyUrl,
		caFileOverride: env["OPENCLAW_PROXY_CA_FILE"]
	});
	try {
		return loadManagedProxyTlsOptionsSync(proxyCaFile);
	} catch {
		return;
	}
}
function addActiveManagedProxyTlsOptions(options, params) {
	const proxyTls = resolveActiveManagedProxyTlsOptions({
		proxyUrl: readProxyUrlFromOptions(options),
		env: params?.env
	});
	if (!proxyTls) return options;
	const existingProxyTls = readProxyTlsRecord(options);
	return {
		...options,
		proxyTls: {
			...proxyTls,
			...existingProxyTls
		}
	};
}
function resolveManagedEnvHttpProxyAgentOptions(env = process.env) {
	return addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions(env), { env });
}
//#endregion
export { loadManagedProxyTlsOptionsSync as a, loadManagedProxyTlsOptions as i, resolveActiveManagedProxyTlsOptions as n, resolveManagedProxyCaFileForUrl as o, resolveManagedEnvHttpProxyAgentOptions as r, addActiveManagedProxyTlsOptions as t };
