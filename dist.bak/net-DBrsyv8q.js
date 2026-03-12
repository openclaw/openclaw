import { d as normalizeIpAddress, i as isCanonicalDottedDecimalIPv4, l as isLoopbackIpAddress, o as isIpInCidr } from "./ip-BDxIP8rd.js";
import { n as pickPrimaryTailnetIPv4 } from "./tailnet-Ca1WnFBq.js";
import os from "node:os";
import { Buffer } from "node:buffer";
import net from "node:net";

//#region src/infra/ws.ts
function rawDataToString(data, encoding = "utf8") {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString(encoding);
	if (Array.isArray(data)) return Buffer.concat(data).toString(encoding);
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString(encoding);
	return Buffer.from(String(data)).toString(encoding);
}

//#endregion
//#region src/gateway/net.ts
/**
* Pick the primary non-internal IPv4 address (LAN IP).
* Prefers common interface names (en0, eth0) then falls back to any external IPv4.
*/
function pickPrimaryLanIPv4() {
	const nets = os.networkInterfaces();
	for (const name of ["en0", "eth0"]) {
		const entry = nets[name]?.find((n) => n.family === "IPv4" && !n.internal);
		if (entry?.address) return entry.address;
	}
	for (const list of Object.values(nets)) {
		const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
		if (entry?.address) return entry.address;
	}
}
function normalizeHostHeader(hostHeader) {
	return (hostHeader ?? "").trim().toLowerCase();
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
/**
* Resolves gateway bind host with fallback strategy.
*
* Modes:
* - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
* - lan: always 0.0.0.0 (no fallback)
* - tailnet: Tailnet IPv4 if available, else loopback
* - auto: Loopback if available, else 0.0.0.0
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
		if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
		return "0.0.0.0";
	}
	return "0.0.0.0";
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
	if (!host) return false;
	const h = host.trim().toLowerCase();
	if (h === "localhost") return true;
	return isLoopbackAddress(h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);
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
* Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
*
* Returns true if the URL is secure for transmitting data:
* - wss:// (TLS) is always secure
* - ws:// is only secure for loopback addresses (localhost, 127.x.x.x, ::1)
*
* All other ws:// URLs are considered insecure because both credentials
* AND chat/conversation data would be exposed to network interception.
*/
function isSecureWebSocketUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "wss:") return true;
	if (parsed.protocol !== "ws:") return false;
	return isLoopbackHost(parsed.hostname);
}

//#endregion
export { isTrustedProxyAddress as a, pickPrimaryLanIPv4 as c, resolveGatewayListenHosts as d, resolveHostName as f, isSecureWebSocketUrl as i, resolveClientIp as l, isLoopbackAddress as n, isValidIPv4 as o, rawDataToString as p, isLoopbackHost as r, normalizeHostHeader as s, isLocalishHost as t, resolveGatewayBindHost as u };