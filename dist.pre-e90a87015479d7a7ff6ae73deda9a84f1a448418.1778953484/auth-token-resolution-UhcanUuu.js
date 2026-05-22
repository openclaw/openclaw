import { m as resolveSecretInputRef } from "./types.secrets-Co1lNtpa.js";
import { a as trimToUndefined } from "./credential-planner-CIP76pyg.js";
import "./credentials-BWN-a-4J.js";
import { t as resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string-e270y3c0.js";
//#region src/gateway/auth-token-resolution.ts
async function resolveGatewayAuthToken(params) {
	const explicitToken = trimToUndefined(params.explicitToken);
	if (explicitToken) return {
		token: explicitToken,
		source: "explicit",
		secretRefConfigured: false
	};
	const tokenInput = params.cfg.gateway?.auth?.token;
	const tokenRef = resolveSecretInputRef({
		value: tokenInput,
		defaults: params.cfg.secrets?.defaults
	}).ref;
	const envFallback = params.envFallback ?? "always";
	const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);
	if (!tokenRef) {
		const configToken = trimToUndefined(tokenInput);
		if (configToken) return {
			token: configToken,
			source: "config",
			secretRefConfigured: false
		};
		if (envFallback !== "never" && envToken) return {
			token: envToken,
			source: "env",
			secretRefConfigured: false
		};
		return { secretRefConfigured: false };
	}
	const resolved = await resolveConfiguredSecretInputString({
		config: params.cfg,
		env: params.env,
		value: tokenInput,
		path: "gateway.auth.token",
		unresolvedReasonStyle: params.unresolvedReasonStyle
	});
	if (resolved.value) return {
		token: resolved.value,
		source: "secretRef",
		secretRefConfigured: true
	};
	if (envFallback === "always" && envToken) return {
		token: envToken,
		source: "env",
		secretRefConfigured: true
	};
	return {
		secretRefConfigured: true,
		unresolvedRefReason: resolved.unresolvedRefReason
	};
}
//#endregion
export { resolveGatewayAuthToken as t };
