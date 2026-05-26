import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { r as resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string-DuewGZmy.js";
import { a as readGatewaySecretInputValue, n as assignResolvedGatewaySecretInput } from "./secret-input-paths-DAMsep3_.js";
//#region src/gateway/auth-config-utils.ts
function hasConfiguredGatewayAuthSecretInput(cfg, path) {
	return hasConfiguredSecretInput(readGatewaySecretInputValue(cfg, path), cfg.secrets?.defaults);
}
function shouldResolveGatewayAuthSecretRef(params) {
	const isTokenPath = params.path === "gateway.auth.token";
	if (isTokenPath ? params.hasTokenCandidate : params.hasPasswordCandidate) return false;
	if (params.mode === (isTokenPath ? "token" : "password")) return true;
	if (params.mode === "token" || params.mode === "none" || params.mode === "trusted-proxy") return false;
	if (params.mode === "password") return !isTokenPath;
	return isTokenPath ? !params.hasPasswordCandidate : !params.hasTokenCandidate;
}
function shouldResolveGatewayTokenSecretRef(params) {
	return shouldResolveGatewayAuthSecretRef({
		mode: params.mode,
		path: "gateway.auth.token",
		hasPasswordCandidate: params.hasPasswordCandidate,
		hasTokenCandidate: params.hasTokenCandidate
	});
}
function shouldResolveGatewayPasswordSecretRef(params) {
	return shouldResolveGatewayAuthSecretRef({
		mode: params.mode,
		path: "gateway.auth.password",
		hasPasswordCandidate: params.hasPasswordCandidate,
		hasTokenCandidate: params.hasTokenCandidate
	});
}
async function resolveGatewayAuthSecretRefValue(params) {
	if (!params.shouldResolve) return;
	const value = await resolveRequiredConfiguredSecretRefInputString({
		config: params.cfg,
		env: params.env,
		value: readGatewaySecretInputValue(params.cfg, params.path),
		path: params.path
	});
	if (!value) return;
	return value;
}
async function resolveGatewayTokenSecretRefValue(params) {
	return resolveGatewayAuthSecretRefValue({
		cfg: params.cfg,
		env: params.env,
		path: "gateway.auth.token",
		shouldResolve: shouldResolveGatewayTokenSecretRef(params)
	});
}
async function resolveGatewayPasswordSecretRefValue(params) {
	return resolveGatewayAuthSecretRefValue({
		cfg: params.cfg,
		env: params.env,
		path: "gateway.auth.password",
		shouldResolve: shouldResolveGatewayPasswordSecretRef(params)
	});
}
async function resolveGatewayAuthSecretRef(params) {
	const value = await resolveGatewayAuthSecretRefValue(params);
	if (!value) return params.cfg;
	const nextConfig = structuredClone(params.cfg);
	nextConfig.gateway ??= {};
	nextConfig.gateway.auth ??= {};
	assignResolvedGatewaySecretInput({
		config: nextConfig,
		path: params.path,
		value
	});
	return nextConfig;
}
async function resolveGatewayPasswordSecretRef(params) {
	return resolveGatewayAuthSecretRef({
		cfg: params.cfg,
		env: params.env,
		path: "gateway.auth.password",
		shouldResolve: shouldResolveGatewayPasswordSecretRef(params)
	});
}
async function materializeGatewayAuthSecretRefs(params) {
	const cfgWithToken = await resolveGatewayAuthSecretRef({
		cfg: params.cfg,
		env: params.env,
		path: "gateway.auth.token",
		shouldResolve: shouldResolveGatewayTokenSecretRef(params)
	});
	return await resolveGatewayPasswordSecretRef({
		cfg: cfgWithToken,
		env: params.env,
		mode: params.mode,
		hasPasswordCandidate: params.hasPasswordCandidate,
		hasTokenCandidate: params.hasTokenCandidate || hasConfiguredGatewayAuthSecretInput(cfgWithToken, "gateway.auth.token")
	});
}
//#endregion
export { resolveGatewayTokenSecretRefValue as i, materializeGatewayAuthSecretRefs as n, resolveGatewayPasswordSecretRefValue as r, hasConfiguredGatewayAuthSecretInput as t };
