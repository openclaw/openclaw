import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { t as assertHttpUrlTargetsPrivateNetwork } from "./ssrf-policy-DsfOWjYU.js";
import "./ssrf-runtime-BGM8nkUl.js";
import "./string-coerce-runtime-BMQDVfjj.js";
import net from "node:net";
//#region extensions/matrix/src/matrix/client/private-network-host.ts
function normalizeHost(host) {
	const normalized = normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
	return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}
function isPrivateIpv4(host) {
	const parts = host.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
function isPrivateIpv6(host) {
	if (host === "::1") return true;
	if (host === "::" || host.startsWith("ff")) return false;
	return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}
function isPrivateOrLoopbackHost(host) {
	const normalized = normalizeHost(host);
	if (!normalized) return false;
	if (normalized === "localhost") return true;
	const family = net.isIP(normalized);
	if (family === 4) return isPrivateIpv4(normalized);
	if (family === 6) return isPrivateIpv6(normalized);
	return false;
}
//#endregion
//#region extensions/matrix/src/matrix/client/url-validation.ts
const MATRIX_HTTP_HOMESERVER_ERROR = "Matrix homeserver must use https:// unless it targets a private or loopback host";
function cleanString(value, requiredMessage) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) throw new Error(requiredMessage);
	return trimmed;
}
function validateMatrixHomeserverUrl(homeserver, opts) {
	const trimmed = cleanString(homeserver, "Matrix homeserver is required (matrix.homeserver)");
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Matrix homeserver must be a valid http(s) URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Matrix homeserver must use http:// or https://");
	if (!parsed.hostname) throw new Error("Matrix homeserver must include a hostname");
	if (parsed.username || parsed.password) throw new Error("Matrix homeserver URL must not include embedded credentials");
	if (parsed.search || parsed.hash) throw new Error("Matrix homeserver URL must not include query strings or fragments");
	if (parsed.protocol === "http:" && opts?.allowPrivateNetwork !== true && !isPrivateOrLoopbackHost(parsed.hostname)) throw new Error(MATRIX_HTTP_HOMESERVER_ERROR);
	return trimmed;
}
async function resolveValidatedMatrixHomeserverUrl(homeserver, opts) {
	const allowPrivateNetwork = typeof opts?.dangerouslyAllowPrivateNetwork === "boolean" ? opts.dangerouslyAllowPrivateNetwork : opts?.allowPrivateNetwork;
	const normalized = validateMatrixHomeserverUrl(homeserver, { allowPrivateNetwork });
	await assertHttpUrlTargetsPrivateNetwork(normalized, {
		dangerouslyAllowPrivateNetwork: opts?.dangerouslyAllowPrivateNetwork,
		allowPrivateNetwork,
		lookupFn: opts?.lookupFn,
		errorMessage: MATRIX_HTTP_HOMESERVER_ERROR
	});
	return normalized;
}
//#endregion
export { validateMatrixHomeserverUrl as n, isPrivateOrLoopbackHost as r, resolveValidatedMatrixHomeserverUrl as t };
