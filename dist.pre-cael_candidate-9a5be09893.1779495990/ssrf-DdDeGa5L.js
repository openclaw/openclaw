import { r as __exportAll } from "./chunk-CNf5ZN-e.js";
import { _ as parseLooseIpAddress, c as isIpv4Address, d as isLinkLocalIpAddress, g as parseCanonicalIpAddress, i as isCanonicalDottedDecimalIPv4, n as isBlockedSpecialUseIpv4Address, o as isCloudMetadataIpAddress, r as isBlockedSpecialUseIpv6Address, t as extractEmbeddedIpv4FromIpv6, u as isLegacyIpv4Literal } from "./ip-WAe3-2zT.js";
import { n as createHttp1EnvHttpProxyAgent, r as createHttp1ProxyAgent, t as createHttp1Agent } from "./undici-runtime-DWGlO0I7.js";
import { t as normalizeHostname } from "./hostname-DX6nIUV7.js";
import { lookup } from "node:dns";
import { lookup as lookup$1 } from "node:dns/promises";
//#region src/infra/net/ssrf.ts
var ssrf_exports = /* @__PURE__ */ __exportAll({
	SsrFBlockedError: () => SsrFBlockedError,
	assertHostnameAllowedWithPolicy: () => assertHostnameAllowedWithPolicy,
	assertPublicHostname: () => assertPublicHostname,
	closeDispatcher: () => closeDispatcher,
	createPinnedDispatcher: () => createPinnedDispatcher,
	createPinnedLookup: () => createPinnedLookup,
	isBlockedHostname: () => isBlockedHostname,
	isBlockedHostnameOrIp: () => isBlockedHostnameOrIp,
	isHostnameAllowedByPattern: () => isHostnameAllowedByPattern,
	isPrivateIpAddress: () => isPrivateIpAddress,
	isPrivateNetworkAllowedByPolicy: () => isPrivateNetworkAllowedByPolicy,
	isSameSsrFPolicy: () => isSameSsrFPolicy,
	matchesHostnameAllowlist: () => matchesHostnameAllowlist,
	mergeSsrFPolicies: () => mergeSsrFPolicies,
	normalizeHostnameAllowlist: () => normalizeHostnameAllowlist,
	resolvePinnedHostname: () => resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy: () => resolvePinnedHostnameWithPolicy,
	resolveSsrFPolicyForUrl: () => resolveSsrFPolicyForUrl,
	ssrfPolicyFromHttpBaseUrlAllowedHostname: () => ssrfPolicyFromHttpBaseUrlAllowedHostname,
	ssrfPolicyFromHttpBaseUrlAllowedOrigin: () => ssrfPolicyFromHttpBaseUrlAllowedOrigin,
	ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist: () => ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist
});
const DISPATCHER_CLOSE_TIMEOUT_MS = 100;
var SsrFBlockedError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SsrFBlockedError";
	}
};
function normalizeSsrFPolicyHostnames(values) {
	if (!values || values.length === 0) return [];
	return Array.from(new Set(values.map((value) => normalizeHostname(value)).filter(Boolean))).toSorted();
}
function normalizeSsrFPolicyForComparison(policy) {
	if (!policy) return null;
	return {
		allowPrivateNetwork: policy.allowPrivateNetwork === true,
		dangerouslyAllowPrivateNetwork: policy.dangerouslyAllowPrivateNetwork === true,
		allowRfc2544BenchmarkRange: policy.allowRfc2544BenchmarkRange === true,
		allowIpv6UniqueLocalRange: policy.allowIpv6UniqueLocalRange === true,
		allowedHostnames: normalizeSsrFPolicyHostnames(policy.allowedHostnames),
		allowedOrigins: normalizeSsrFPolicyOrigins(policy.allowedOrigins),
		hostnameAllowlist: [...normalizeHostnameAllowlist(policy.hostnameAllowlist)].toSorted()
	};
}
function isSameSsrFPolicy(a, b) {
	return JSON.stringify(normalizeSsrFPolicyForComparison(a)) === JSON.stringify(normalizeSsrFPolicyForComparison(b));
}
function mergeSsrFPolicies(...policies) {
	const merged = {};
	for (const policy of policies) {
		if (!policy) continue;
		if (policy.allowPrivateNetwork) merged.allowPrivateNetwork = true;
		if (policy.dangerouslyAllowPrivateNetwork) merged.dangerouslyAllowPrivateNetwork = true;
		if (policy.allowRfc2544BenchmarkRange) merged.allowRfc2544BenchmarkRange = true;
		if (policy.allowIpv6UniqueLocalRange) merged.allowIpv6UniqueLocalRange = true;
		if (policy.allowedHostnames?.length) merged.allowedHostnames = Array.from(new Set([...merged.allowedHostnames ?? [], ...policy.allowedHostnames]));
		if (policy.allowedOrigins?.length) merged.allowedOrigins = Array.from(new Set([...merged.allowedOrigins ?? [], ...policy.allowedOrigins]));
		if (policy.hostnameAllowlist?.length) merged.hostnameAllowlist = Array.from(new Set([...merged.hostnameAllowlist ?? [], ...policy.hostnameAllowlist]));
	}
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return { allowedHostnames: [parsed.hostname] };
	} catch {
		return;
	}
}
function normalizeSsrFPolicyOrigin(value) {
	const trimmed = value.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		parsed.hostname = parsed.hostname.replace(/\.+$/, "");
		return parsed.origin.toLowerCase();
	} catch {
		return;
	}
}
function normalizeSsrFPolicyOrigins(values) {
	if (!values || values.length === 0) return [];
	return Array.from(new Set(values.map((value) => normalizeSsrFPolicyOrigin(value)).filter((value) => Boolean(value)))).toSorted();
}
function ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl) {
	const origin = normalizeSsrFPolicyOrigin(baseUrl);
	return origin ? { allowedOrigins: [origin] } : void 0;
}
function ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return {
			allowRfc2544BenchmarkRange: true,
			allowIpv6UniqueLocalRange: true,
			hostnameAllowlist: [parsed.hostname]
		};
	} catch {
		return;
	}
}
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal"
]);
function normalizeHostnameSet(values) {
	if (!values || values.length === 0) return /* @__PURE__ */ new Set();
	return new Set(values.map((value) => normalizeHostname(value)).filter(Boolean));
}
function normalizeHostnameAllowlist(values) {
	if (!values || values.length === 0) return [];
	return Array.from(new Set(values.map((value) => normalizeHostname(value)).filter((value) => value !== "*" && value !== "*." && value.length > 0)));
}
function isPrivateNetworkAllowedByPolicy(policy) {
	return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}
function shouldSkipPrivateNetworkChecks(hostname, policy) {
	return isPrivateNetworkAllowedByPolicy(policy) || normalizeHostnameSet(policy?.allowedHostnames).has(hostname);
}
function resolveSsrFPolicyForUrl(url, policy) {
	if (!policy?.allowedOrigins?.length) return policy;
	const requestOrigin = normalizeSsrFPolicyOrigin(url.toString());
	if (!requestOrigin || !normalizeSsrFPolicyOrigins(policy.allowedOrigins).includes(requestOrigin)) return policy;
	return {
		...policy,
		allowedHostnames: Array.from(new Set([...policy.allowedHostnames ?? [], normalizeHostname(url.hostname)]))
	};
}
function resolveIpv4SpecialUseBlockOptions(policy) {
	return { allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true };
}
function resolveIpv6SpecialUseBlockOptions(policy) {
	return { allowUniqueLocalRange: policy?.allowIpv6UniqueLocalRange === true };
}
function isHostnameAllowedByPattern(hostname, pattern) {
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(2);
		if (!suffix || hostname === suffix) return false;
		return hostname.endsWith(`.${suffix}`);
	}
	return hostname === pattern;
}
function matchesHostnameAllowlist(hostname, allowlist) {
	if (allowlist.length === 0) return true;
	return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}
function looksLikeUnsupportedIpv4Literal(address) {
	const parts = address.split(".");
	if (parts.length === 0 || parts.length > 4) return false;
	if (parts.some((part) => part.length === 0)) return true;
	return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}
function isPrivateIpAddress(address, policy) {
	const normalized = normalizeHostname(address);
	if (!normalized) return false;
	const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);
	const ipv6BlockOptions = resolveIpv6SpecialUseBlockOptions(policy);
	const strictIp = parseCanonicalIpAddress(normalized);
	if (strictIp) {
		if (isIpv4Address(strictIp)) return isBlockedSpecialUseIpv4Address(strictIp, blockOptions);
		if (isBlockedSpecialUseIpv6Address(strictIp, ipv6BlockOptions)) return true;
		const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
		if (embeddedIpv4) return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);
		return false;
	}
	if (normalized.includes(":") && !parseLooseIpAddress(normalized)) return true;
	if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) return true;
	if (looksLikeUnsupportedIpv4Literal(normalized)) return true;
	return false;
}
function isBlockedHostname(hostname) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) return false;
	return isBlockedHostnameNormalized(normalized);
}
function isBlockedHostnameNormalized(normalized) {
	if (BLOCKED_HOSTNAMES.has(normalized)) return true;
	return normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal");
}
function isBlockedHostnameOrIp(hostname, policy) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) return false;
	return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}
const BLOCKED_HOST_OR_IP_MESSAGE = "Blocked hostname or private/internal/special-use IP address";
const BLOCKED_RESOLVED_IP_MESSAGE = "Blocked: resolves to private/internal/special-use IP address";
function assertAllowedHostOrIpOrThrow(hostnameOrIp, policy) {
	if (isBlockedHostnameOrIp(hostnameOrIp, policy)) throw new SsrFBlockedError(BLOCKED_HOST_OR_IP_MESSAGE);
}
function resolveHostnamePolicyChecks(hostname, policy) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) throw new Error("Invalid hostname");
	const hostnameAllowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);
	const skipPrivateNetworkChecks = shouldSkipPrivateNetworkChecks(normalized, policy);
	if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);
	if (!skipPrivateNetworkChecks) assertAllowedHostOrIpOrThrow(normalized, policy);
	return {
		normalized,
		skipPrivateNetworkChecks
	};
}
function assertAllowedResolvedAddressesOrThrow(results, policy) {
	for (const entry of results) if (isBlockedHostnameOrIp(entry.address, policy)) throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);
}
function assertAllowedTrustedHostnameResolvedAddressesOrThrow(results) {
	for (const entry of results) if (isLinkLocalIpAddress(entry.address) || isCloudMetadataIpAddress(entry.address)) throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);
}
function normalizeLookupResults(results) {
	if (Array.isArray(results)) return results;
	return [results];
}
function createPinnedLookup(params) {
	const normalizedHost = normalizeHostname(params.hostname);
	if (params.addresses.length === 0) throw new Error(`Pinned lookup requires at least one address for ${params.hostname}`);
	const fallback = params.fallback ?? lookup;
	const fallbackLookup = fallback;
	const fallbackWithOptions = fallback;
	const records = params.addresses.map((address) => ({
		address,
		family: address.includes(":") ? 6 : 4
	}));
	const ipv4Records = records.filter((entry) => entry.family === 4);
	const automaticRecords = ipv4Records.length > 0 ? ipv4Records : records;
	let index = 0;
	return ((host, options, callback) => {
		const cb = typeof options === "function" ? options : callback;
		if (!cb) return;
		const normalized = normalizeHostname(host);
		if (!normalized || normalized !== normalizedHost) {
			if (typeof options === "function" || options === void 0) return fallbackLookup(host, cb);
			return fallbackWithOptions(host, options, cb);
		}
		const opts = typeof options === "object" && options !== null ? options : {};
		const requestedFamily = typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
		const candidates = requestedFamily === 4 || requestedFamily === 6 ? records.filter((entry) => entry.family === requestedFamily) : automaticRecords;
		const usable = candidates.length > 0 ? candidates : automaticRecords;
		if (opts.all) {
			cb(null, usable);
			return;
		}
		const chosen = usable[index % usable.length];
		index += 1;
		cb(null, chosen.address, chosen.family);
	});
}
function dedupeAndPreferIpv4(results) {
	const seen = /* @__PURE__ */ new Set();
	const ipv4 = [];
	const otherFamilies = [];
	for (const entry of results) {
		if (seen.has(entry.address)) continue;
		seen.add(entry.address);
		if (entry.family === 4) {
			ipv4.push(entry.address);
			continue;
		}
		otherFamilies.push(entry.address);
	}
	return [...ipv4, ...otherFamilies];
}
async function resolvePinnedHostnameWithPolicy(hostname, params = {}) {
	const { normalized, skipPrivateNetworkChecks } = resolveHostnamePolicyChecks(hostname, params.policy);
	const results = normalizeLookupResults(await (params.lookupFn ?? lookup$1)(normalized, { all: true }));
	if (results.length === 0) throw new Error(`Unable to resolve hostname: ${hostname}`);
	if (!skipPrivateNetworkChecks) assertAllowedResolvedAddressesOrThrow(results, params.policy);
	else if (!isPrivateNetworkAllowedByPolicy(params.policy)) assertAllowedTrustedHostnameResolvedAddressesOrThrow(results);
	const addresses = dedupeAndPreferIpv4(results);
	if (addresses.length === 0) throw new Error(`Unable to resolve hostname: ${hostname}`);
	return {
		hostname: normalized,
		addresses,
		lookup: createPinnedLookup({
			hostname: normalized,
			addresses
		})
	};
}
function assertHostnameAllowedWithPolicy(hostname, policy) {
	return resolveHostnamePolicyChecks(hostname, policy).normalized;
}
async function resolvePinnedHostname(hostname, lookupFn = lookup$1) {
	return await resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
}
function withPinnedLookup(lookup, connect) {
	return connect ? {
		...connect,
		lookup
	} : { lookup };
}
function resolvePinnedDispatcherLookup(pinned, override, policy) {
	if (!override) return pinned.lookup;
	const normalizedOverrideHost = normalizeHostname(override.hostname);
	if (!normalizedOverrideHost || normalizedOverrideHost !== pinned.hostname) throw new Error(`Pinned dispatcher override hostname mismatch: expected ${pinned.hostname}, got ${override.hostname}`);
	const records = override.addresses.map((address) => ({
		address,
		family: address.includes(":") ? 6 : 4
	}));
	if (!shouldSkipPrivateNetworkChecks(pinned.hostname, policy)) assertAllowedResolvedAddressesOrThrow(records, policy);
	else if (!isPrivateNetworkAllowedByPolicy(policy)) assertAllowedTrustedHostnameResolvedAddressesOrThrow(records);
	return createPinnedLookup({
		hostname: pinned.hostname,
		addresses: [...override.addresses],
		fallback: pinned.lookup
	});
}
function createPinnedDispatcher(pinned, policy, ssrfPolicy, timeoutMs) {
	const lookup = resolvePinnedDispatcherLookup(pinned, policy?.pinnedHostname, ssrfPolicy);
	if (!policy || policy.mode === "direct") return createHttp1Agent({ connect: withPinnedLookup(lookup, policy?.connect) }, timeoutMs);
	if (policy.mode === "env-proxy") return createHttp1EnvHttpProxyAgent({
		connect: withPinnedLookup(lookup, policy.connect),
		...policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}
	}, timeoutMs);
	const proxyUrl = policy.proxyUrl.trim();
	const requestTls = withPinnedLookup(lookup, policy.proxyTls);
	if (!requestTls) return createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
	return createHttp1ProxyAgent({
		uri: proxyUrl,
		requestTls
	}, timeoutMs);
}
function destroyDispatcher(candidate) {
	try {
		candidate.destroy?.();
	} catch {}
}
async function waitForDispatcherClose(candidate) {
	const close = candidate.close;
	if (typeof close !== "function") {
		destroyDispatcher(candidate);
		return;
	}
	let timeout;
	try {
		await Promise.race([Promise.resolve(close.call(candidate)), new Promise((resolve) => {
			timeout = setTimeout(() => {
				timeout = void 0;
				destroyDispatcher(candidate);
				resolve();
			}, DISPATCHER_CLOSE_TIMEOUT_MS);
			timeout.unref?.();
		})]);
	} catch (err) {
		destroyDispatcher(candidate);
		throw err;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function closeDispatcher(dispatcher) {
	if (!dispatcher) return;
	const candidate = dispatcher;
	try {
		await waitForDispatcherClose(candidate);
	} catch {}
}
async function assertPublicHostname(hostname, lookupFn = lookup$1) {
	await resolvePinnedHostname(hostname, lookupFn);
}
//#endregion
export { ssrf_exports as S, resolvePinnedHostnameWithPolicy as _, createPinnedDispatcher as a, ssrfPolicyFromHttpBaseUrlAllowedOrigin as b, isBlockedHostnameOrIp as c, isPrivateNetworkAllowedByPolicy as d, isSameSsrFPolicy as f, resolvePinnedHostname as g, normalizeHostnameAllowlist as h, closeDispatcher as i, isHostnameAllowedByPattern as l, mergeSsrFPolicies as m, assertHostnameAllowedWithPolicy as n, createPinnedLookup as o, matchesHostnameAllowlist as p, assertPublicHostname as r, isBlockedHostname as s, SsrFBlockedError as t, isPrivateIpAddress as u, resolveSsrFPolicyForUrl as v, ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist as x, ssrfPolicyFromHttpBaseUrlAllowedHostname as y };
