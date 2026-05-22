import { s as hasConfiguredSecretInput } from "./types.secrets-CL51SR4g.js";
//#region src/gateway/auth-mode-policy.ts
const EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR = "Invalid config: gateway.auth.token and gateway.auth.password are both configured, but gateway.auth.mode is unset. Set gateway.auth.mode to token or password.";
function hasAmbiguousGatewayAuthModeConfig(cfg) {
	const auth = cfg.gateway?.auth;
	if (!auth) return false;
	if (typeof auth.mode === "string" && auth.mode.trim().length > 0) return false;
	const defaults = cfg.secrets?.defaults;
	const tokenConfigured = hasConfiguredSecretInput(auth.token, defaults);
	const passwordConfigured = hasConfiguredSecretInput(auth.password, defaults);
	return tokenConfigured && passwordConfigured;
}
function assertExplicitGatewayAuthModeWhenBothConfigured(cfg) {
	if (!hasAmbiguousGatewayAuthModeConfig(cfg)) return;
	throw new Error(EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR);
}
//#endregion
export { assertExplicitGatewayAuthModeWhenBothConfigured as n, hasAmbiguousGatewayAuthModeConfig as r, EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR as t };
