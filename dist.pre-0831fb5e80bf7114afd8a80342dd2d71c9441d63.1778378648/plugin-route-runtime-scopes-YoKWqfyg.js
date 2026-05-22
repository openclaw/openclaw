import { o as WRITE_SCOPE } from "./operator-scopes-DnLX99-0.js";
import { t as CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes-DBW2bjZx.js";
import { a as getHeader, d as resolveTrustedHttpOperatorScopes } from "./http-auth-utils-DwLXJvsY.js";
//#region src/gateway/server/plugin-route-runtime-scopes.ts
function resolvePluginRouteRuntimeOperatorScopes(req, requestAuth, surface = "write-default") {
	if (surface === "trusted-operator") {
		if (!requestAuth.trustDeclaredOperatorScopes) return [...CLI_DEFAULT_OPERATOR_SCOPES];
		return resolveTrustedHttpOperatorScopes(req, requestAuth);
	}
	if (requestAuth.authMethod !== "trusted-proxy") return [WRITE_SCOPE];
	if (getHeader(req, "x-openclaw-scopes") === void 0) return [WRITE_SCOPE];
	return resolveTrustedHttpOperatorScopes(req, requestAuth);
}
//#endregion
export { resolvePluginRouteRuntimeOperatorScopes as t };
