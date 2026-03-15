import { qd as resolveGatewayCredentialsWithSecretInputs } from "./auth-profiles-DqxBs6Au.js";
import { g as isGatewaySecretRefUnavailableError, y as resolveGatewayProbeCredentialsFromConfig } from "./config-VO8zzMSR.js";
//#region src/gateway/probe-auth.ts
function buildGatewayProbeCredentialPolicy(params) {
	return {
		config: params.cfg,
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		mode: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	};
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
		includeLegacyEnv: policy.includeLegacyEnv,
		remoteTokenFallback: policy.remoteTokenFallback
	});
}
function resolveGatewayProbeAuthSafe(params) {
	const explicitToken = params.explicitAuth?.token?.trim();
	const explicitPassword = params.explicitAuth?.password?.trim();
	if (explicitToken || explicitPassword) {return { auth: {
		...explicitToken ? { token: explicitToken } : {},
		...explicitPassword ? { password: explicitPassword } : {}
	} };}
	try {
		return { auth: resolveGatewayProbeAuth(params) };
	} catch (error) {
		if (!isGatewaySecretRefUnavailableError(error)) {throw error;}
		return {
			auth: {},
			warning: `${error.path} SecretRef is unresolved in this command path; probing without configured auth credentials.`
		};
	}
}
//#endregion
export { resolveGatewayProbeAuthSafe as n, resolveGatewayProbeAuthWithSecretInputs as r, resolveGatewayProbeAuth as t };
