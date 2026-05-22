import { r as authorizeHttpGatewayConnect } from "./auth-p1uCwunm.js";
import { i as hasAuthorizedPluginNodeCapability } from "./plugin-node-capability-BDDz-xUq.js";
import { i as getBearerToken, s as resolveHttpBrowserOriginPolicy } from "./http-auth-utils-B7VgHYig.js";
//#region src/gateway/server/plugin-node-capability-auth.ts
async function authorizePluginNodeCapabilityRequest(params) {
	const { req, auth, trustedProxies, allowRealIpFallback, clients, nodeCapability, capability, malformedScopedPath, rateLimiter } = params;
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
	if (capability && hasAuthorizedPluginNodeCapability({
		clients,
		surface: nodeCapability,
		capability
	})) return { ok: true };
	return lastAuthFailure ?? {
		ok: false,
		reason: "unauthorized"
	};
}
//#endregion
export { authorizePluginNodeCapabilityRequest };
