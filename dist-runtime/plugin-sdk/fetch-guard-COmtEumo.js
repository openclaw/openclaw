import { r as bindAbortRelay } from "./fetch-s6LpGbVn.js";
import { i as logWarn } from "./logger-kC9I1OJ3.js";
import { n as hasProxyEnvConfigured } from "./proxy-env-G6JgJlRw.js";
import ipaddr from "ipaddr.js";
import { lookup } from "node:dns";
import { lookup as lookup$1 } from "node:dns/promises";
import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici";
//#region src/shared/net/ip.ts
const BLOCKED_IPV4_SPECIAL_USE_RANGES = new Set([
	"unspecified",
	"broadcast",
	"multicast",
	"linkLocal",
	"loopback",
	"carrierGradeNat",
	"private",
	"reserved"
]);
const PRIVATE_OR_LOOPBACK_IPV4_RANGES = new Set([
	"loopback",
	"private",
	"linkLocal",
	"carrierGradeNat"
]);
const BLOCKED_IPV6_SPECIAL_USE_RANGES = new Set([
	"unspecified",
	"loopback",
	"linkLocal",
	"uniqueLocal",
	"multicast"
]);
const RFC2544_BENCHMARK_PREFIX = [ipaddr.IPv4.parse("198.18.0.0"), 15];
const EMBEDDED_IPV4_SENTINEL_RULES = [
	{
		matches: (parts) => parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0,
		toHextets: (parts) => [parts[6], parts[7]]
	},
	{
		matches: (parts) => parts[0] === 100 && parts[1] === 65435 && parts[2] === 1 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0,
		toHextets: (parts) => [parts[6], parts[7]]
	},
	{
		matches: (parts) => parts[0] === 8194,
		toHextets: (parts) => [parts[1], parts[2]]
	},
	{
		matches: (parts) => parts[0] === 8193 && parts[1] === 0,
		toHextets: (parts) => [parts[6] ^ 65535, parts[7] ^ 65535]
	},
	{
		matches: (parts) => (parts[4] & 64767) === 0 && parts[5] === 24318,
		toHextets: (parts) => [parts[6], parts[7]]
	}
];
function stripIpv6Brackets(value) {
	if (value.startsWith("[") && value.endsWith("]")) {return value.slice(1, -1);}
	return value;
}
function isNumericIpv4LiteralPart(value) {
	return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}
function parseIpv6WithEmbeddedIpv4(raw) {
	if (!raw.includes(":") || !raw.includes(".")) {return;}
	const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
	if (!match) {return;}
	const [, prefix, embeddedIpv4, zoneSuffix = ""] = match;
	if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) {return;}
	const octets = embeddedIpv4.split(".").map((part) => Number.parseInt(part, 10));
	const normalizedIpv6 = `${prefix}${(octets[0] << 8 | octets[1]).toString(16)}:${(octets[2] << 8 | octets[3]).toString(16)}${zoneSuffix}`;
	if (!ipaddr.IPv6.isValid(normalizedIpv6)) {return;}
	return ipaddr.IPv6.parse(normalizedIpv6);
}
function isIpv4Address(address) {
	return address.kind() === "ipv4";
}
function isIpv6Address(address) {
	return address.kind() === "ipv6";
}
function normalizeIpv4MappedAddress(address) {
	if (!isIpv6Address(address)) {return address;}
	if (!address.isIPv4MappedAddress()) {return address;}
	return address.toIPv4Address();
}
function normalizeIpParseInput(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) {return;}
	return stripIpv6Brackets(trimmed);
}
function parseCanonicalIpAddress(raw) {
	const normalized = normalizeIpParseInput(raw);
	if (!normalized) {return;}
	if (ipaddr.IPv4.isValid(normalized)) {
		if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) {return;}
		return ipaddr.IPv4.parse(normalized);
	}
	if (ipaddr.IPv6.isValid(normalized)) {return ipaddr.IPv6.parse(normalized);}
	return parseIpv6WithEmbeddedIpv4(normalized);
}
function parseLooseIpAddress(raw) {
	const normalized = normalizeIpParseInput(raw);
	if (!normalized) {return;}
	if (ipaddr.isValid(normalized)) {return ipaddr.parse(normalized);}
	return parseIpv6WithEmbeddedIpv4(normalized);
}
function normalizeIpAddress(raw) {
	const parsed = parseCanonicalIpAddress(raw);
	if (!parsed) {return;}
	return normalizeIpv4MappedAddress(parsed).toString().toLowerCase();
}
function isCanonicalDottedDecimalIPv4(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) {return false;}
	const normalized = stripIpv6Brackets(trimmed);
	if (!normalized) {return false;}
	return ipaddr.IPv4.isValidFourPartDecimal(normalized);
}
function isLegacyIpv4Literal(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) {return false;}
	const normalized = stripIpv6Brackets(trimmed);
	if (!normalized || normalized.includes(":")) {return false;}
	if (isCanonicalDottedDecimalIPv4(normalized)) {return false;}
	const parts = normalized.split(".");
	if (parts.length === 0 || parts.length > 4) {return false;}
	if (parts.some((part) => part.length === 0)) {return false;}
	if (!parts.every((part) => isNumericIpv4LiteralPart(part))) {return false;}
	return true;
}
function isLoopbackIpAddress(raw) {
	const parsed = parseCanonicalIpAddress(raw);
	if (!parsed) {return false;}
	return normalizeIpv4MappedAddress(parsed).range() === "loopback";
}
function isPrivateOrLoopbackIpAddress(raw) {
	const parsed = parseCanonicalIpAddress(raw);
	if (!parsed) {return false;}
	const normalized = normalizeIpv4MappedAddress(parsed);
	if (isIpv4Address(normalized)) {return PRIVATE_OR_LOOPBACK_IPV4_RANGES.has(normalized.range());}
	return isBlockedSpecialUseIpv6Address(normalized);
}
function isBlockedSpecialUseIpv6Address(address) {
	if (BLOCKED_IPV6_SPECIAL_USE_RANGES.has(address.range())) {return true;}
	return (address.parts[0] & 65472) === 65216;
}
function isBlockedSpecialUseIpv4Address(address, options = {}) {
	const inRfc2544BenchmarkRange = address.match(RFC2544_BENCHMARK_PREFIX);
	if (inRfc2544BenchmarkRange && options.allowRfc2544BenchmarkRange === true) {return false;}
	return BLOCKED_IPV4_SPECIAL_USE_RANGES.has(address.range()) || inRfc2544BenchmarkRange;
}
function decodeIpv4FromHextets(high, low) {
	const octets = [
		high >>> 8 & 255,
		high & 255,
		low >>> 8 & 255,
		low & 255
	];
	return ipaddr.IPv4.parse(octets.join("."));
}
function extractEmbeddedIpv4FromIpv6(address) {
	if (address.isIPv4MappedAddress()) {return address.toIPv4Address();}
	if (address.range() === "rfc6145") {return decodeIpv4FromHextets(address.parts[6], address.parts[7]);}
	if (address.range() === "rfc6052") {return decodeIpv4FromHextets(address.parts[6], address.parts[7]);}
	for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
		if (!rule.matches(address.parts)) {continue;}
		const [high, low] = rule.toHextets(address.parts);
		return decodeIpv4FromHextets(high, low);
	}
}
function isIpInCidr(ip, cidr) {
	const normalizedIp = parseCanonicalIpAddress(ip);
	if (!normalizedIp) {return false;}
	const candidate = cidr.trim();
	if (!candidate) {return false;}
	const comparableIp = normalizeIpv4MappedAddress(normalizedIp);
	if (!candidate.includes("/")) {
		const exact = parseCanonicalIpAddress(candidate);
		if (!exact) {return false;}
		const comparableExact = normalizeIpv4MappedAddress(exact);
		return comparableIp.kind() === comparableExact.kind() && comparableIp.toString() === comparableExact.toString();
	}
	let parsedCidr;
	try {
		parsedCidr = ipaddr.parseCIDR(candidate);
	} catch {
		return false;
	}
	const [baseAddress, prefixLength] = parsedCidr;
	const comparableBase = normalizeIpv4MappedAddress(baseAddress);
	if (comparableIp.kind() !== comparableBase.kind()) {return false;}
	try {
		if (isIpv4Address(comparableIp) && isIpv4Address(comparableBase)) {return comparableIp.match([comparableBase, prefixLength]);}
		if (isIpv6Address(comparableIp) && isIpv6Address(comparableBase)) {return comparableIp.match([comparableBase, prefixLength]);}
		return false;
	} catch {
		return false;
	}
}
//#endregion
//#region src/infra/net/hostname.ts
function normalizeHostname(hostname) {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (normalized.startsWith("[") && normalized.endsWith("]")) {return normalized.slice(1, -1);}
	return normalized;
}
//#endregion
//#region src/infra/net/ssrf.ts
var SsrFBlockedError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SsrFBlockedError";
	}
};
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal"
]);
function normalizeHostnameSet(values) {
	if (!values || values.length === 0) {return /* @__PURE__ */ new Set();}
	return new Set(values.map((value) => normalizeHostname(value)).filter(Boolean));
}
function normalizeHostnameAllowlist(values) {
	if (!values || values.length === 0) {return [];}
	return Array.from(new Set(values.map((value) => normalizeHostname(value)).filter((value) => value !== "*" && value !== "*." && value.length > 0)));
}
function isPrivateNetworkAllowedByPolicy(policy) {
	return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}
function resolveIpv4SpecialUseBlockOptions(policy) {
	return { allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true };
}
function isHostnameAllowedByPattern(hostname, pattern) {
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(2);
		if (!suffix || hostname === suffix) {return false;}
		return hostname.endsWith(`.${suffix}`);
	}
	return hostname === pattern;
}
function matchesHostnameAllowlist(hostname, allowlist) {
	if (allowlist.length === 0) {return true;}
	return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}
function looksLikeUnsupportedIpv4Literal(address) {
	const parts = address.split(".");
	if (parts.length === 0 || parts.length > 4) {return false;}
	if (parts.some((part) => part.length === 0)) {return true;}
	return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}
function isPrivateIpAddress(address, policy) {
	let normalized = address.trim().toLowerCase();
	if (normalized.startsWith("[") && normalized.endsWith("]")) {normalized = normalized.slice(1, -1);}
	if (!normalized) {return false;}
	const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);
	const strictIp = parseCanonicalIpAddress(normalized);
	if (strictIp) {
		if (isIpv4Address(strictIp)) {return isBlockedSpecialUseIpv4Address(strictIp, blockOptions);}
		if (isBlockedSpecialUseIpv6Address(strictIp)) {return true;}
		const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
		if (embeddedIpv4) {return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);}
		return false;
	}
	if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {return true;}
	if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) {return true;}
	if (looksLikeUnsupportedIpv4Literal(normalized)) {return true;}
	return false;
}
function isBlockedHostname(hostname) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) {return false;}
	return isBlockedHostnameNormalized(normalized);
}
function isBlockedHostnameNormalized(normalized) {
	if (BLOCKED_HOSTNAMES.has(normalized)) {return true;}
	return normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal");
}
function isBlockedHostnameOrIp(hostname, policy) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) {return false;}
	return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}
const BLOCKED_HOST_OR_IP_MESSAGE = "Blocked hostname or private/internal/special-use IP address";
const BLOCKED_RESOLVED_IP_MESSAGE = "Blocked: resolves to private/internal/special-use IP address";
function assertAllowedHostOrIpOrThrow(hostnameOrIp, policy) {
	if (isBlockedHostnameOrIp(hostnameOrIp, policy)) {throw new SsrFBlockedError(BLOCKED_HOST_OR_IP_MESSAGE);}
}
function assertAllowedResolvedAddressesOrThrow(results, policy) {
	for (const entry of results) {if (isBlockedHostnameOrIp(entry.address, policy)) throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);}
}
function createPinnedLookup(params) {
	const normalizedHost = normalizeHostname(params.hostname);
	const fallback = params.fallback ?? lookup;
	const fallbackLookup = fallback;
	const fallbackWithOptions = fallback;
	const records = params.addresses.map((address) => ({
		address,
		family: address.includes(":") ? 6 : 4
	}));
	let index = 0;
	return ((host, options, callback) => {
		const cb = typeof options === "function" ? options : callback;
		if (!cb) {return;}
		const normalized = normalizeHostname(host);
		if (!normalized || normalized !== normalizedHost) {
			if (typeof options === "function" || options === void 0) {return fallbackLookup(host, cb);}
			return fallbackWithOptions(host, options, cb);
		}
		const opts = typeof options === "object" && options !== null ? options : {};
		const requestedFamily = typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
		const candidates = requestedFamily === 4 || requestedFamily === 6 ? records.filter((entry) => entry.family === requestedFamily) : records;
		const usable = candidates.length > 0 ? candidates : records;
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
		if (seen.has(entry.address)) {continue;}
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
	const normalized = normalizeHostname(hostname);
	if (!normalized) {throw new Error("Invalid hostname");}
	const allowPrivateNetwork = isPrivateNetworkAllowedByPolicy(params.policy);
	const allowedHostnames = normalizeHostnameSet(params.policy?.allowedHostnames);
	const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);
	const isExplicitAllowed = allowedHostnames.has(normalized);
	const skipPrivateNetworkChecks = allowPrivateNetwork || isExplicitAllowed;
	if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);}
	if (!skipPrivateNetworkChecks) {assertAllowedHostOrIpOrThrow(normalized, params.policy);}
	const results = await (params.lookupFn ?? lookup$1)(normalized, { all: true });
	if (results.length === 0) {throw new Error(`Unable to resolve hostname: ${hostname}`);}
	if (!skipPrivateNetworkChecks) {assertAllowedResolvedAddressesOrThrow(results, params.policy);}
	const addresses = dedupeAndPreferIpv4(results);
	if (addresses.length === 0) {throw new Error(`Unable to resolve hostname: ${hostname}`);}
	return {
		hostname: normalized,
		addresses,
		lookup: createPinnedLookup({
			hostname: normalized,
			addresses
		})
	};
}
function withPinnedLookup(lookup, connect) {
	return connect ? {
		...connect,
		lookup
	} : { lookup };
}
function createPinnedDispatcher(pinned, policy) {
	if (!policy || policy.mode === "direct") {return new Agent({ connect: withPinnedLookup(pinned.lookup, policy?.connect) });}
	if (policy.mode === "env-proxy") {return new EnvHttpProxyAgent({
		connect: withPinnedLookup(pinned.lookup, policy.connect),
		...policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}
	});}
	const proxyUrl = policy.proxyUrl.trim();
	if (!policy.proxyTls) {return new ProxyAgent(proxyUrl);}
	return new ProxyAgent({
		uri: proxyUrl,
		proxyTls: { ...policy.proxyTls }
	});
}
async function closeDispatcher(dispatcher) {
	if (!dispatcher) {return;}
	const candidate = dispatcher;
	try {
		if (typeof candidate.close === "function") {
			await candidate.close();
			return;
		}
		if (typeof candidate.destroy === "function") {candidate.destroy();}
	} catch {}
}
//#endregion
//#region src/infra/net/fetch-guard.ts
const GUARDED_FETCH_MODE = {
	STRICT: "strict",
	TRUSTED_ENV_PROXY: "trusted_env_proxy"
};
const DEFAULT_MAX_REDIRECTS = 3;
const CROSS_ORIGIN_REDIRECT_SAFE_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"content-language",
	"content-type",
	"if-match",
	"if-modified-since",
	"if-none-match",
	"if-unmodified-since",
	"pragma",
	"range",
	"user-agent"
]);
function withStrictGuardedFetchMode(params) {
	return {
		...params,
		mode: GUARDED_FETCH_MODE.STRICT
	};
}
function withTrustedEnvProxyGuardedFetchMode(params) {
	return {
		...params,
		mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY
	};
}
function resolveGuardedFetchMode(params) {
	if (params.mode) {return params.mode;}
	if (params.proxy === "env" && params.dangerouslyAllowEnvProxyWithoutPinnedDns === true) {return GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY;}
	return GUARDED_FETCH_MODE.STRICT;
}
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function retainSafeHeadersForCrossOriginRedirect(init) {
	if (!init?.headers) {return init;}
	const incoming = new Headers(init.headers);
	const headers = new Headers();
	for (const [key, value] of incoming.entries()) {if (CROSS_ORIGIN_REDIRECT_SAFE_HEADERS.has(key.toLowerCase())) headers.set(key, value);}
	return {
		...init,
		headers
	};
}
function buildAbortSignal(params) {
	const { timeoutMs, signal } = params;
	if (!timeoutMs && !signal) {return {
		signal: void 0,
		cleanup: () => {}
	};}
	if (!timeoutMs) {return {
		signal,
		cleanup: () => {}
	};}
	const controller = new AbortController();
	const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
	const onAbort = bindAbortRelay(controller);
	if (signal) {if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });}
	const cleanup = () => {
		clearTimeout(timeoutId);
		if (signal) {signal.removeEventListener("abort", onAbort);}
	};
	return {
		signal: controller.signal,
		cleanup
	};
}
async function fetchWithSsrFGuard(params) {
	const fetcher = params.fetchImpl ?? globalThis.fetch;
	if (!fetcher) {throw new Error("fetch is not available");}
	const maxRedirects = typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects) ? Math.max(0, Math.floor(params.maxRedirects)) : DEFAULT_MAX_REDIRECTS;
	const mode = resolveGuardedFetchMode(params);
	const { signal, cleanup } = buildAbortSignal({
		timeoutMs: params.timeoutMs,
		signal: params.signal
	});
	let released = false;
	const release = async (dispatcher) => {
		if (released) {return;}
		released = true;
		cleanup();
		await closeDispatcher(dispatcher ?? void 0);
	};
	const visited = /* @__PURE__ */ new Set();
	let currentUrl = params.url;
	let currentInit = params.init ? { ...params.init } : void 0;
	let redirectCount = 0;
	while (true) {
		let parsedUrl;
		try {
			parsedUrl = new URL(currentUrl);
		} catch {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}
		let dispatcher = null;
		try {
			const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
				lookupFn: params.lookupFn,
				policy: params.policy
			});
			if (mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured()) {dispatcher = new EnvHttpProxyAgent();}
			else if (params.pinDns !== false) {dispatcher = createPinnedDispatcher(pinned, params.dispatcherPolicy);}
			const init = {
				...currentInit ? { ...currentInit } : {},
				redirect: "manual",
				...dispatcher ? { dispatcher } : {},
				...signal ? { signal } : {}
			};
			const response = await fetcher(parsedUrl.toString(), init);
			if (isRedirectStatus(response.status)) {
				const location = response.headers.get("location");
				if (!location) {
					await release(dispatcher);
					throw new Error(`Redirect missing location header (${response.status})`);
				}
				redirectCount += 1;
				if (redirectCount > maxRedirects) {
					await release(dispatcher);
					throw new Error(`Too many redirects (limit: ${maxRedirects})`);
				}
				const nextParsedUrl = new URL(location, parsedUrl);
				const nextUrl = nextParsedUrl.toString();
				if (visited.has(nextUrl)) {
					await release(dispatcher);
					throw new Error("Redirect loop detected");
				}
				if (nextParsedUrl.origin !== parsedUrl.origin) {currentInit = retainSafeHeadersForCrossOriginRedirect(currentInit);}
				visited.add(nextUrl);
				response.body?.cancel();
				await closeDispatcher(dispatcher);
				currentUrl = nextUrl;
				continue;
			}
			return {
				response,
				finalUrl: currentUrl,
				release: async () => release(dispatcher)
			};
		} catch (err) {
			if (err instanceof SsrFBlockedError) {logWarn(`security: blocked URL fetch (${params.auditContext ?? "url-fetch"}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`);}
			await release(dispatcher);
			throw err;
		}
	}
}
//#endregion
export { isBlockedHostname as a, isPrivateNetworkAllowedByPolicy as c, isCanonicalDottedDecimalIPv4 as d, isIpInCidr as f, normalizeIpAddress as h, SsrFBlockedError as i, resolvePinnedHostnameWithPolicy as l, isPrivateOrLoopbackIpAddress as m, withStrictGuardedFetchMode as n, isBlockedHostnameOrIp as o, isLoopbackIpAddress as p, withTrustedEnvProxyGuardedFetchMode as r, isPrivateIpAddress as s, fetchWithSsrFGuard as t, normalizeHostname as u };
