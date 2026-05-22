import { t as safeEqualSecret } from "./secret-equal-Dpb8a2q9.js";
import { r as authorizeHttpGatewayConnect } from "./auth-ARvHEIK7.js";
import "./file-resolver-DhlhEvHn.js";
import "./a2ui-C89i526T.js";
import { i as getBearerToken, s as resolveHttpBrowserOriginPolicy } from "./http-auth-utils-Cn-3XwQh.js";
import { t as CANVAS_CAPABILITY_TTL_MS } from "./canvas-capability-bQZw6l2o.js";
//#region src/gateway/server/http-auth.ts
function isCanvasPath(pathname) {
	return pathname === "/__openclaw__/a2ui" || pathname.startsWith(`/__openclaw__/a2ui/`) || pathname === "/__openclaw__/canvas" || pathname.startsWith(`/__openclaw__/canvas/`) || pathname === "/__openclaw__/ws";
}
function hasAuthorizedWsClientForCanvasCapability(clients, capability) {
	const nowMs = Date.now();
	for (const client of clients) {
		if (!client.canvasCapability || !client.canvasCapabilityExpiresAtMs) continue;
		if (client.canvasCapabilityExpiresAtMs <= nowMs) continue;
		if (safeEqualSecret(client.canvasCapability, capability)) {
			client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
			return true;
		}
	}
	return false;
}
async function authorizeCanvasRequest(params) {
	const { req, auth, trustedProxies, allowRealIpFallback, clients, canvasCapability, malformedScopedPath, rateLimiter } = params;
	if (malformedScopedPath) return {
		ok: false,
		reason: "unauthorized"
	};
	let lastAuthFailure = null;
	const token = getBearerToken(req);
	if (token) {
		const authResult = await authorizeHttpGatewayConnect({
			auth: {
				...auth,
				allowTailscale: false
			},
			connectAuth: {
				token,
				password: token
			},
			req,
			trustedProxies,
			allowRealIpFallback,
			rateLimiter,
			browserOriginPolicy: resolveHttpBrowserOriginPolicy(req)
		});
		if (authResult.ok) return authResult;
		lastAuthFailure = authResult;
	}
	if (canvasCapability && hasAuthorizedWsClientForCanvasCapability(clients, canvasCapability)) return { ok: true };
	return lastAuthFailure ?? {
		ok: false,
		reason: "unauthorized"
	};
}
//#endregion
export { authorizeCanvasRequest, isCanvasPath };
