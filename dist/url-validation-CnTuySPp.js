import { o as isPrivateOrLoopbackHost } from "./net-DCUMtgJy.js";
import { t as assertHttpUrlTargetsPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
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
export { validateMatrixHomeserverUrl as n, resolveValidatedMatrixHomeserverUrl as t };
