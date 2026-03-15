import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Agent, ProxyAgent } from "undici";
//#region src/infra/gaxios-fetch-compat.ts
const TEST_GAXIOS_CONSTRUCTOR_OVERRIDE = "__OPENCLAW_TEST_GAXIOS_CONSTRUCTOR__";
let installState = "not-installed";
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function hasDispatcher(value) {
	return isRecord(value) && typeof value.dispatch === "function";
}
function hasProxyAgentShape(value) {
	return isRecord(value) && value.proxy instanceof URL;
}
function hasTlsAgentShape(value) {
	return isRecord(value) && isRecord(value.options);
}
function resolveTlsOptions(init, url) {
	const explicit = {
		cert: init.cert,
		key: init.key
	};
	if (explicit.cert !== void 0 || explicit.key !== void 0) {return explicit;}
	const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
	if (hasProxyAgentShape(agent)) {return {
		cert: agent.connectOpts?.cert,
		key: agent.connectOpts?.key
	};}
	if (hasTlsAgentShape(agent)) {return {
		cert: agent.options?.cert,
		key: agent.options?.key
	};}
	return {};
}
function urlMayUseProxy(url, noProxy = []) {
	const rules = [...noProxy];
	const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
	for (const rule of envRules) {
		const trimmed = rule.trim();
		if (trimmed.length > 0) {rules.push(trimmed);}
	}
	for (const rule of rules) {
		if (rule instanceof RegExp) {
			if (rule.test(url.toString())) {return false;}
			continue;
		}
		if (rule instanceof URL) {
			if (rule.origin === url.origin) {return false;}
			continue;
		}
		if (rule.startsWith("*.") || rule.startsWith(".")) {
			const cleanedRule = rule.replace(/^\*\./, ".");
			if (url.hostname.endsWith(cleanedRule)) {return false;}
			continue;
		}
		if (rule === url.origin || rule === url.hostname || rule === url.href) {return false;}
	}
	return true;
}
function resolveProxyUri(init, url) {
	if (init.proxy) {
		const proxyUri = String(init.proxy);
		return urlMayUseProxy(url, init.noProxy) ? proxyUri : void 0;
	}
	const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	if (!envProxy) {return;}
	return urlMayUseProxy(url, init.noProxy) ? envProxy : void 0;
}
function buildDispatcher(init, url) {
	if (init.dispatcher) {return init.dispatcher;}
	const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
	if (hasDispatcher(agent)) {return agent;}
	const { cert, key } = resolveTlsOptions(init, url);
	const proxyUri = resolveProxyUri(init, url) ?? (hasProxyAgentShape(agent) ? String(agent.proxy) : void 0);
	if (proxyUri) {return new ProxyAgent({
		requestTls: cert !== void 0 || key !== void 0 ? {
			cert,
			key
		} : void 0,
		uri: proxyUri
	});}
	if (cert !== void 0 || key !== void 0) {return new Agent({ connect: {
		cert,
		key
	} });}
}
function isModuleNotFoundError(err) {
	return isRecord(err) && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND");
}
function hasGaxiosConstructorShape(value) {
	return typeof value === "function" && "prototype" in value && isRecord(value.prototype) && typeof value.prototype._defaultAdapter === "function";
}
function getTestGaxiosConstructorOverride() {
	const testGlobal = globalThis;
	if (!Object.prototype.hasOwnProperty.call(testGlobal, TEST_GAXIOS_CONSTRUCTOR_OVERRIDE)) {return;}
	const override = testGlobal[TEST_GAXIOS_CONSTRUCTOR_OVERRIDE];
	if (override === null) {return null;}
	if (hasGaxiosConstructorShape(override)) {return override;}
	throw new Error("invalid gaxios test constructor override");
}
function isDirectGaxiosImportMiss(err) {
	if (!isModuleNotFoundError(err)) {return false;}
	return typeof err.message === "string" && (err.message.includes("Cannot find package 'gaxios'") || err.message.includes("Cannot find module 'gaxios'"));
}
async function loadGaxiosConstructor() {
	const testOverride = getTestGaxiosConstructorOverride();
	if (testOverride !== void 0) {return testOverride;}
	try {
		const mod = await import(pathToFileURL(createRequire(import.meta.url).resolve("gaxios")).href);
		const candidate = isRecord(mod) ? mod.Gaxios : void 0;
		if (!hasGaxiosConstructorShape(candidate)) {throw new Error("gaxios: missing Gaxios export");}
		return candidate;
	} catch (err) {
		if (isDirectGaxiosImportMiss(err)) {return null;}
		throw err;
	}
}
function installLegacyWindowFetchShim() {
	if (typeof globalThis.fetch !== "function" || typeof globalThis.window !== "undefined") {return;}
	globalThis.window = { fetch: globalThis.fetch };
}
function createGaxiosCompatFetch(baseFetch = globalThis.fetch) {
	return async (input, init) => {
		const gaxiosInit = init ?? {};
		const dispatcher = buildDispatcher(gaxiosInit, input instanceof Request ? new URL(input.url) : new URL(typeof input === "string" ? input : input.toString()));
		const nextInit = { ...gaxiosInit };
		delete nextInit.agent;
		delete nextInit.cert;
		delete nextInit.fetchImplementation;
		delete nextInit.key;
		delete nextInit.noProxy;
		delete nextInit.proxy;
		if (dispatcher) {nextInit.dispatcher = dispatcher;}
		return baseFetch(input, nextInit);
	};
}
async function installGaxiosFetchCompat() {
	if (installState !== "not-installed" || typeof globalThis.fetch !== "function") {return;}
	installState = "installing";
	try {
		const Gaxios = await loadGaxiosConstructor();
		if (!Gaxios) {
			installLegacyWindowFetchShim();
			installState = "shimmed";
			return;
		}
		const prototype = Gaxios.prototype;
		const originalDefaultAdapter = prototype._defaultAdapter;
		const compatFetch = createGaxiosCompatFetch();
		prototype._defaultAdapter = function patchedDefaultAdapter(config) {
			if (config.fetchImplementation) {return originalDefaultAdapter.call(this, config);}
			return originalDefaultAdapter.call(this, {
				...config,
				fetchImplementation: compatFetch
			});
		};
		installState = "installed";
	} catch (err) {
		installState = "not-installed";
		throw err;
	}
}
//#endregion
export { createGaxiosCompatFetch, installGaxiosFetchCompat };
