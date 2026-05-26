import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { a as readNetworkInterfaces, i as pickMatchingExternalInterfaceAddress, n as pickPrimaryTailnetIPv4, o as safeNetworkInterfaces } from "./tailnet-D6Ui4WCo.js";
import { f as isLoopbackIpAddress, h as normalizeIpAddress, i as isCanonicalDottedDecimalIPv4, p as isPrivateOrLoopbackIpAddress, s as isIpInCidr } from "./ip-WAe3-2zT.js";
import fs from "node:fs";
import net from "node:net";
//#region src/infra/container-environment.ts
/**
* Detect whether the current process is running inside a container
* (Docker, Podman, or Kubernetes).
*
* Uses two reliable heuristics:
* - Presence of common container sentinel files.
* - Container-related entries in /proc/1/cgroup.
*
* The result is cached after the first call so filesystem access happens at
* most once per process lifetime.
*/
let containerEnvironmentCache;
function isContainerEnvironment() {
	if (containerEnvironmentCache !== void 0) return containerEnvironmentCache;
	containerEnvironmentCache = detectContainerEnvironment();
	return containerEnvironmentCache;
}
function detectContainerEnvironment() {
	if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) return true;
	for (const sentinelPath of [
		"/.dockerenv",
		"/run/.containerenv",
		"/var/run/.containerenv"
	]) try {
		fs.accessSync(sentinelPath, fs.constants.F_OK);
		return true;
	} catch {}
	try {
		const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
		if (/\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(cgroup)) return true;
	} catch {}
	return false;
}
//#endregion
//#region src/gateway/net.ts
/**
* Pick the primary non-internal IPv4 address (LAN IP).
* Prefers common interface names (en0, eth0) then falls back to any external IPv4.
*/
function pickPrimaryLanIPv4() {
	return pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
		family: "IPv4",
		preferredNames: ["en0", "eth0"]
	});
}
function normalizeHostHeader(hostHeader) {
	return normalizeLowercaseStringOrEmpty(hostHeader);
}
function resolveHostName(hostHeader) {
	const host = normalizeHostHeader(hostHeader);
	if (!host) return "";
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		if (end !== -1) return host.slice(1, end);
	}
	if (net.isIP(host) === 6) return host;
	const [name] = host.split(":");
	return name ?? "";
}
function isLoopbackAddress(ip) {
	return isLoopbackIpAddress(ip);
}
function resolveLocalInterfaceAddressMatch(ip, snapshot) {
	const normalized = normalizeIp(ip);
	if (!normalized) return false;
	const effectiveSnapshot = arguments.length >= 2 ? snapshot : safeNetworkInterfaces();
	if (!effectiveSnapshot) return;
	for (const entries of Object.values(effectiveSnapshot)) for (const entry of entries ?? []) if (normalizeIp(entry.address) === normalized) return true;
	return false;
}
/**
* Returns true if the IP belongs to a private or loopback network range.
* Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
*/
function isPrivateOrLoopbackAddress(ip) {
	return isPrivateOrLoopbackIpAddress(ip);
}
function normalizeIp(ip) {
	return normalizeIpAddress(ip);
}
function stripOptionalPort(ip) {
	if (ip.startsWith("[")) {
		const end = ip.indexOf("]");
		if (end !== -1) return ip.slice(1, end);
	}
	if (net.isIP(ip)) return ip;
	const lastColon = ip.lastIndexOf(":");
	if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
		const candidate = ip.slice(0, lastColon);
		if (net.isIP(candidate) === 4) return candidate;
	}
	return ip;
}
function parseIpLiteral(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	const normalized = normalizeIp(stripOptionalPort(trimmed));
	if (!normalized || net.isIP(normalized) === 0) return;
	return normalized;
}
function parseRealIp(realIp) {
	return parseIpLiteral(realIp);
}
function resolveForwardedClientIp(params) {
	const { forwardedFor, trustedProxies } = params;
	if (!trustedProxies?.length) return;
	const forwardedChain = [];
	for (const entry of forwardedFor?.split(",") ?? []) {
		const normalized = parseIpLiteral(entry);
		if (normalized) forwardedChain.push(normalized);
	}
	if (forwardedChain.length === 0) return;
	for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
		const hop = forwardedChain[index];
		if (isLoopbackAddress(hop)) continue;
		if (!isTrustedProxyAddress(hop, trustedProxies)) return hop;
	}
}
function isTrustedProxyAddress(ip, trustedProxies) {
	const normalized = normalizeIp(ip);
	if (!normalized || !trustedProxies || trustedProxies.length === 0) return false;
	return trustedProxies.some((proxy) => {
		const candidate = proxy.trim();
		if (!candidate) return false;
		return isIpInCidr(normalized, candidate);
	});
}
function resolveClientIp(params) {
	const remote = normalizeIp(params.remoteAddr);
	if (!remote) return;
	if (!isTrustedProxyAddress(remote, params.trustedProxies)) return remote;
	const forwardedIp = resolveForwardedClientIp({
		forwardedFor: params.forwardedFor,
		trustedProxies: params.trustedProxies
	});
	if (forwardedIp) return forwardedIp;
	if (params.allowRealIpFallback) return parseRealIp(params.realIp);
}
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
function resolveRequestClientIp(req, trustedProxies, allowRealIpFallback = false) {
	if (!req) return;
	return resolveClientIp({
		remoteAddr: req.socket?.remoteAddress ?? "",
		forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
		realIp: headerValue(req.headers?.["x-real-ip"]),
		trustedProxies,
		allowRealIpFallback
	});
}
/**
* Resolves gateway bind host with fallback strategy.
*
* Modes:
* - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
* - lan: always 0.0.0.0 (no fallback)
* - tailnet: Tailnet IPv4 if available, else loopback
* - auto: 0.0.0.0 inside containers (Docker/Podman/K8s); loopback otherwise
* - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
*
* @returns The bind address to use (never null)
*/
async function resolveGatewayBindHost(bind, customHost) {
	const mode = bind ?? "loopback";
	if (mode === "loopback") {
		if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
		return "0.0.0.0";
	}
	if (mode === "tailnet") {
		const tailnetIP = pickPrimaryTailnetIPv4();
		if (tailnetIP && await canBindToHost(tailnetIP)) return tailnetIP;
		if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
		return "0.0.0.0";
	}
	if (mode === "lan") return "0.0.0.0";
	if (mode === "custom") {
		const host = customHost?.trim();
		if (!host) return "0.0.0.0";
		if (isValidIPv4(host) && await canBindToHost(host)) return host;
		return "0.0.0.0";
	}
	if (mode === "auto") {
		if (isContainerEnvironment()) return "0.0.0.0";
		if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
		return "0.0.0.0";
	}
	return "0.0.0.0";
}
/**
* Returns the effective default bind mode when `gateway.bind` is not explicitly
* configured. Inside a detected container environment the default is `"auto"`
* (which resolves to `0.0.0.0` for port-forwarding compatibility); on bare-metal
* / VM hosts the default remains `"loopback"`.
*
* When {@link tailscaleMode} is `"serve"` or `"funnel"`, the function always
* returns `"loopback"` because Tailscale serve/funnel architecturally requires
* a loopback bind — container auto-detection must never override this.
*
* Use this only in gateway startup codepaths that execute in the same
* environment as the eventual bind decision. Host-side diagnostics should keep
* their own explicit defaults instead of inferring from the caller process.
*/
function defaultGatewayBindMode(tailscaleMode) {
	if (tailscaleMode && tailscaleMode !== "off") return "loopback";
	return isContainerEnvironment() ? "auto" : "loopback";
}
/**
* Test if we can bind to a specific host address.
* Creates a temporary server, attempts to bind, then closes it.
*
* @param host - The host address to test
* @returns True if we can successfully bind to this address
*/
async function canBindToHost(host) {
	return new Promise((resolve) => {
		const testServer = net.createServer();
		testServer.once("error", () => {
			resolve(false);
		});
		testServer.once("listening", () => {
			testServer.close();
			resolve(true);
		});
		testServer.listen(0, host);
	});
}
async function resolveGatewayListenHosts(bindHost, opts) {
	if (bindHost !== "127.0.0.1") return [bindHost];
	if (process.platform === "win32") return [bindHost];
	if (await (opts?.canBindToHost ?? canBindToHost)("::1")) return [bindHost, "::1"];
	return [bindHost];
}
/**
* Validate if a string is a valid IPv4 address.
*
* @param host - The string to validate
* @returns True if valid IPv4 format
*/
function isValidIPv4(host) {
	return isCanonicalDottedDecimalIPv4(host);
}
/**
* Check if a hostname or IP refers to the local machine.
* Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
* Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
*/
function isLoopbackHost(host) {
	const parsed = parseHostForAddressChecks(host);
	if (!parsed) return false;
	if (parsed.isLocalhost) return true;
	return isLoopbackAddress(parsed.unbracketedHost);
}
/**
* Local-facing host check for inbound requests:
* - loopback hosts (localhost/127.x/::1 and mapped forms)
* - Tailscale Serve/Funnel hostnames (*.ts.net)
*/
function isLocalishHost(hostHeader) {
	const host = resolveHostName(hostHeader);
	if (!host) return false;
	return isLoopbackHost(host) || host.endsWith(".ts.net");
}
/**
* Check if a hostname or IP refers to a private or loopback address.
* Handles the same hostname formats as isLoopbackHost, but also accepts
* RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
*/
function isPrivateOrLoopbackHost(host) {
	const parsed = parseHostForAddressChecks(host);
	if (!parsed) return false;
	if (parsed.isLocalhost) return true;
	const normalized = normalizeIp(parsed.unbracketedHost);
	if (!normalized || !isPrivateOrLoopbackAddress(normalized)) return false;
	if (net.isIP(normalized) === 6) {
		if (normalized.startsWith("ff")) return false;
		if (normalized === "::") return false;
	}
	return true;
}
function parseHostForAddressChecks(host) {
	if (!host) return null;
	const normalizedHost = normalizeLowercaseStringOrEmpty(host);
	const canonicalHost = normalizedHost.replace(/\.+$/, "");
	if (canonicalHost === "localhost") return {
		isLocalhost: true,
		unbracketedHost: canonicalHost
	};
	return {
		isLocalhost: false,
		unbracketedHost: normalizedHost.startsWith("[") && normalizedHost.endsWith("]") ? normalizedHost.slice(1, -1) : normalizedHost
	};
}
/**
* Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
*
* Returns true if the URL is secure for transmitting data:
* - wss:// (TLS) is always secure
* - ws:// is secure for loopback, private IP literals, .local, and Tailnet hosts
* - optional break-glass: other private-DNS ws:// hostnames can be enabled for trusted networks
*
* All other ws:// URLs are considered insecure because both credentials
* AND chat/conversation data would be exposed to network interception.
*/
function isSecureWebSocketUrl(url, opts) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
	if (protocol === "wss:") return true;
	if (protocol !== "ws:") return false;
	if (isLoopbackHost(parsed.hostname)) return true;
	if (isTrustedPlaintextWebSocketHost(parsed.hostname)) return true;
	if (opts?.allowPrivateWs) {
		if (isPrivateOrLoopbackHost(parsed.hostname)) return true;
		const hostForIpCheck = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
		return net.isIP(hostForIpCheck) === 0;
	}
	return false;
}
function isTrustedPlaintextWebSocketHost(hostname) {
	if (isPrivateOrLoopbackHost(hostname)) return true;
	const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
	return normalized.endsWith(".local") || normalized.endsWith(".ts.net");
}
//#endregion
export { resolveRequestClientIp as _, isPrivateOrLoopbackAddress as a, isTrustedProxyAddress as c, pickPrimaryLanIPv4 as d, resolveClientIp as f, resolveLocalInterfaceAddressMatch as g, resolveHostName as h, isLoopbackHost as i, isValidIPv4 as l, resolveGatewayListenHosts as m, isLocalishHost as n, isPrivateOrLoopbackHost as o, resolveGatewayBindHost as p, isLoopbackAddress as r, isSecureWebSocketUrl as s, defaultGatewayBindMode as t, normalizeHostHeader as u, isContainerEnvironment as v };
