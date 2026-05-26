import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as resolveGatewayProbeCredentialsFromConfig, n as isGatewaySecretRefUnavailableError } from "./credentials-BJ7jvgw3.js";
import { t as resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs-OTPqgPcC.js";
//#region src/gateway/probe-auth.ts
function buildGatewayProbeCredentialPolicy(params) {
	const cfg = resolveGatewayProbeCredentialConfig(params);
	return {
		config: cfg,
		cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		mode: params.mode,
		remoteTokenFallback: "remote-only"
	};
}
function resolveGatewayProbeCredentialConfig(params) {
	if (params.mode !== "local") return params.cfg;
	const remote = params.cfg.gateway?.remote;
	if (!remote || remote.token === void 0 && remote.password === void 0) return params.cfg;
	const remoteWithoutAuth = { ...remote };
	delete remoteWithoutAuth.token;
	delete remoteWithoutAuth.password;
	return {
		...params.cfg,
		gateway: {
			...params.cfg.gateway,
			remote: remoteWithoutAuth
		}
	};
}
function resolveExplicitProbeAuth(explicitAuth) {
	return {
		token: normalizeOptionalString(explicitAuth?.token),
		password: normalizeOptionalString(explicitAuth?.password)
	};
}
function hasExplicitProbeAuth(auth) {
	return Boolean(auth.token || auth.password);
}
function buildUnresolvedProbeAuthWarning(path) {
	return `${path} SecretRef is unresolved in this command path; probing without configured auth credentials.`;
}
function resolveGatewayProbeWarning(error) {
	if (!isGatewaySecretRefUnavailableError(error)) throw error;
	return buildUnresolvedProbeAuthWarning(error.path);
}
function resolveGatewayProbeAuth(params) {
	return resolveGatewayProbeCredentialsFromConfig(buildGatewayProbeCredentialPolicy(params));
}
async function resolveGatewayProbeAuthWithSecretInputs(params) {
	const policy = buildGatewayProbeCredentialPolicy(params);
	return await resolveGatewayCredentialsWithSecretInputs({
		config: policy.config,
		env: policy.env,
		explicitAuth: policy.explicitAuth,
		modeOverride: policy.modeOverride,
		remoteTokenFallback: policy.remoteTokenFallback
	});
}
async function resolveGatewayProbeAuthSafeWithSecretInputs(params) {
	const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
	if (hasExplicitProbeAuth(explicitAuth)) return { auth: explicitAuth };
	try {
		return { auth: await resolveGatewayProbeAuthWithSecretInputs(params) };
	} catch (error) {
		return {
			auth: {},
			warning: resolveGatewayProbeWarning(error)
		};
	}
}
function resolveGatewayProbeAuthSafe(params) {
	const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
	if (hasExplicitProbeAuth(explicitAuth)) return { auth: explicitAuth };
	try {
		return { auth: resolveGatewayProbeAuth(params) };
	} catch (error) {
		return {
			auth: {},
			warning: resolveGatewayProbeWarning(error)
		};
	}
}
//#endregion
export { resolveGatewayProbeAuthWithSecretInputs as i, resolveGatewayProbeAuthSafe as n, resolveGatewayProbeAuthSafeWithSecretInputs as r, resolveGatewayProbeAuth as t };
