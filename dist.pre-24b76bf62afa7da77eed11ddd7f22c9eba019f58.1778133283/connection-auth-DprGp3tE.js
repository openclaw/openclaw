import "./credentials-C2Z-A-ED.js";
import { t as resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs-D-ucs18_.js";
//#region src/gateway/connection-auth.ts
function toGatewayCredentialOptions(params) {
	return {
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		urlOverride: params.urlOverride,
		urlOverrideSource: params.urlOverrideSource,
		modeOverride: params.modeOverride,
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
