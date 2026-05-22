import { n as authorizeOperatorScopesForMethod } from "./method-scopes-CxQ1l6Zn.js";
import { a as sendMethodNotAllowed, i as sendJson, t as readJsonBodyOrError } from "./http-common-C_Ls2SMr.js";
import { d as resolveTrustedHttpOperatorScopes, t as authorizeGatewayHttpRequestOrReply } from "./http-auth-utils-6RAVyAK7.js";
import "./http-utils-DAm_BBnE.js";
//#region src/gateway/http-endpoint-helpers.ts
async function handleGatewayPostJsonEndpoint(req, res, opts) {
	if (new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname !== opts.pathname) return false;
	if (req.method !== "POST") {
		sendMethodNotAllowed(res);
		return;
	}
	const requestAuth = await authorizeGatewayHttpRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter
	});
	if (!requestAuth) return;
	if (opts.requiredOperatorMethod) {
		const requestedScopes = opts.resolveOperatorScopes?.(req, requestAuth) ?? resolveTrustedHttpOperatorScopes(req, requestAuth);
		const scopeAuth = authorizeOperatorScopesForMethod(opts.requiredOperatorMethod, requestedScopes);
		if (!scopeAuth.allowed) {
			sendJson(res, 403, {
				ok: false,
				error: {
					type: "forbidden",
					message: `missing scope: ${scopeAuth.missingScope}`
				}
			});
			return;
		}
	}
	const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
	if (body === void 0) return;
	return {
		body,
		requestAuth
	};
}
//#endregion
export { handleGatewayPostJsonEndpoint as t };
