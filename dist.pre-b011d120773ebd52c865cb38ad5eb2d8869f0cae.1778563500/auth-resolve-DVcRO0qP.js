import { m as resolveSecretInputRef } from "./types.secrets-CL51SR4g.js";
import { i as resolveGatewayCredentialsFromValues } from "./credentials-DOemEDk6.js";
//#region src/gateway/auth-resolve.ts
function resolveGatewayAuth(params) {
	const baseAuthConfig = params.authConfig ?? {};
	const authOverride = params.authOverride ?? void 0;
	const authConfig = { ...baseAuthConfig };
	if (authOverride) {
		if (authOverride.mode !== void 0) authConfig.mode = authOverride.mode;
		if (authOverride.token !== void 0) authConfig.token = authOverride.token;
		if (authOverride.password !== void 0) authConfig.password = authOverride.password;
		if (authOverride.allowTailscale !== void 0) authConfig.allowTailscale = authOverride.allowTailscale;
		if (authOverride.rateLimit !== void 0) authConfig.rateLimit = authOverride.rateLimit;
		if (authOverride.trustedProxy !== void 0) authConfig.trustedProxy = authOverride.trustedProxy;
	}
	const env = params.env ?? process.env;
	const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
	const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;
	const resolvedCredentials = resolveGatewayCredentialsFromValues({
		configToken: tokenRef ? void 0 : authConfig.token,
		configPassword: passwordRef ? void 0 : authConfig.password,
		env,
		tokenPrecedence: "config-first",
		passwordPrecedence: "config-first"
	});
	const token = resolvedCredentials.token;
	const password = resolvedCredentials.password;
	const trustedProxy = authConfig.trustedProxy;
	let mode;
	let modeSource;
	if (authOverride?.mode !== void 0) {
		mode = authOverride.mode;
		modeSource = "override";
	} else if (authConfig.mode) {
		mode = authConfig.mode;
		modeSource = "config";
	} else if (password) {
		mode = "password";
		modeSource = "password";
	} else if (token) {
		mode = "token";
		modeSource = "token";
	} else {
		mode = "token";
		modeSource = "default";
	}
	const allowTailscale = authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
	return {
		mode,
		modeSource,
		token,
		password,
		allowTailscale,
		trustedProxy
	};
}
function resolveEffectiveSharedGatewayAuth(params) {
	const resolvedAuth = resolveGatewayAuth(params);
	if (resolvedAuth.mode === "token") return {
		mode: "token",
		secret: resolvedAuth.token
	};
	if (resolvedAuth.mode === "password") return {
		mode: "password",
		secret: resolvedAuth.password
	};
	return null;
}
//#endregion
export { resolveGatewayAuth as n, resolveEffectiveSharedGatewayAuth as t };
