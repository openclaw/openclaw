import { Kd as resolveGatewayCredentialsWithSecretInputs } from "./auth-profiles-DAOR1fRn.js";
//#region src/gateway/connection-auth.ts
function toGatewayCredentialOptions(params) {
	return {
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		urlOverride: params.urlOverride,
		urlOverrideSource: params.urlOverrideSource,
		modeOverride: params.modeOverride,
		includeLegacyEnv: params.includeLegacyEnv,
		localTokenPrecedence: params.localTokenPrecedence,
		localPasswordPrecedence: params.localPasswordPrecedence,
		remoteTokenPrecedence: params.remoteTokenPrecedence,
		remotePasswordPrecedence: params.remotePasswordPrecedence,
		remoteTokenFallback: params.remoteTokenFallback,
		remotePasswordFallback: params.remotePasswordFallback
	};
}
async function resolveGatewayConnectionAuth(params) {
	return await resolveGatewayCredentialsWithSecretInputs({
		config: params.config,
		...toGatewayCredentialOptions({
			...params,
			cfg: params.config
		})
	});
}
//#endregion
export { resolveGatewayConnectionAuth as t };
