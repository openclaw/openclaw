import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { n as isNonEmptyString } from "./shared-Cv5g0_Ch.js";
import { o as resolveSecretRefValues } from "./resolve-D1Ko6pWx.js";
import { t as assertNoOAuthSecretRefPolicyViolations } from "./policy-sFxeew7c.js";
import { t as collectConfigAssignments } from "./runtime-config-collectors-CX76Hnah.js";
import { l as pushWarning, r as createResolverContext, s as pushAssignment, t as applyResolvedAssignments } from "./runtime-shared-CPFXAPqc.js";
import { t as resolveRuntimeWebTools } from "./runtime-web-tools-BWcHW4P-.js";
//#region src/secrets/runtime-auth-collectors.ts
function collectApiKeyProfileAssignment(params) {
	const { explicitRef: keyRef, inlineRef: inlineKeyRef, ref: resolvedKeyRef } = resolveSecretInputRef({
		value: params.profile.key,
		refValue: params.profile.keyRef,
		defaults: params.defaults
	});
	if (!resolvedKeyRef) return;
	if (!keyRef && inlineKeyRef) params.profile.keyRef = inlineKeyRef;
	if (keyRef && isNonEmptyString(params.profile.key)) pushWarning(params.context, {
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
		message: `auth-profiles ${params.profileId}: keyRef is set; runtime will ignore plaintext key.`
	});
	pushAssignment(params.context, {
		ref: resolvedKeyRef,
		path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
		expected: "string",
		apply: (value) => {
			params.profile.key = String(value);
		}
	});
}
function collectTokenProfileAssignment(params) {
	const { explicitRef: tokenRef, inlineRef: inlineTokenRef, ref: resolvedTokenRef } = resolveSecretInputRef({
		value: params.profile.token,
		refValue: params.profile.tokenRef,
		defaults: params.defaults
	});
	if (!resolvedTokenRef) return;
	if (!tokenRef && inlineTokenRef) params.profile.tokenRef = inlineTokenRef;
	if (tokenRef && isNonEmptyString(params.profile.token)) pushWarning(params.context, {
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
		message: `auth-profiles ${params.profileId}: tokenRef is set; runtime will ignore plaintext token.`
	});
	pushAssignment(params.context, {
		ref: resolvedTokenRef,
		path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
		expected: "string",
		apply: (value) => {
			params.profile.token = String(value);
		}
	});
}
function collectAuthStoreAssignments(params) {
	assertNoOAuthSecretRefPolicyViolations({
		store: params.store,
		cfg: params.context.sourceConfig,
		context: `auth-profiles ${params.agentDir}`
	});
	const defaults = params.context.sourceConfig.secrets?.defaults;
	for (const [profileId, profile] of Object.entries(params.store.profiles)) {
		if (profile.type === "api_key") {
			collectApiKeyProfileAssignment({
				profile,
				profileId,
				agentDir: params.agentDir,
				defaults,
				context: params.context
			});
			continue;
		}
		if (profile.type === "token") collectTokenProfileAssignment({
			profile,
			profileId,
			agentDir: params.agentDir,
			defaults,
			context: params.context
		});
	}
}
//#endregion
export { applyResolvedAssignments, collectAuthStoreAssignments, collectConfigAssignments, createResolverContext, resolveRuntimeWebTools, resolveSecretRefValues };
