import { m as resolveSecretInputRef, o as coerceSecretRef } from "./types.secrets-CL51SR4g.js";
//#region src/agents/auth-profiles/policy.ts
function pushViolation(violations, profileId, field, reason) {
	violations.push({
		profileId,
		path: `profiles.${profileId}.${field}`,
		reason
	});
}
function hasSecretRefInput(params) {
	return resolveSecretInputRef({
		value: params.value,
		refValue: params.refValue,
		defaults: params.defaults
	}).ref !== null;
}
function collectTypeOAuthSecretRefViolations(params) {
	if (params.credential.type !== "oauth") return;
	const reason = "SecretRef is not allowed for type=\"oauth\" auth profiles (OAuth credentials are runtime-mutable).";
	const record = params.credential;
	for (const field of [
		"access",
		"refresh",
		"token",
		"tokenRef",
		"key",
		"keyRef"
	]) {
		if (coerceSecretRef(record[field], params.defaults) === null) continue;
		pushViolation(params.violations, params.profileId, field, reason);
	}
}
function collectOAuthModeSecretRefViolations(params) {
	if (params.configuredMode !== "oauth") return;
	const reason = `SecretRef is not allowed when auth.profiles.${params.profileId}.mode is "oauth" (OAuth credentials are runtime-mutable).`;
	if (params.credential.type === "api_key") {
		if (hasSecretRefInput({
			value: params.credential.key,
			refValue: params.credential.keyRef,
			defaults: params.defaults
		})) pushViolation(params.violations, params.profileId, "key", reason);
		return;
	}
	if (params.credential.type === "token") {
		if (hasSecretRefInput({
			value: params.credential.token,
			refValue: params.credential.tokenRef,
			defaults: params.defaults
		})) pushViolation(params.violations, params.profileId, "token", reason);
	}
}
function collectOAuthSecretRefPolicyViolations(params) {
	const defaults = params.cfg?.secrets?.defaults;
	const profileFilter = params.profileIds ? new Set(params.profileIds) : null;
	const violations = [];
	for (const [profileId, credential] of Object.entries(params.store.profiles)) {
		if (profileFilter && !profileFilter.has(profileId)) continue;
		collectTypeOAuthSecretRefViolations({
			profileId,
			credential,
			defaults,
			violations
		});
		collectOAuthModeSecretRefViolations({
			profileId,
			credential,
			defaults,
			configuredMode: params.cfg?.auth?.profiles?.[profileId]?.mode,
			violations
		});
	}
	return violations;
}
function assertNoOAuthSecretRefPolicyViolations(params) {
	const violations = collectOAuthSecretRefPolicyViolations(params);
	if (violations.length === 0) return;
	const lines = [`${params.context ?? "auth-profiles"} policy validation failed: OAuth + SecretRef is not supported.`, ...violations.map((violation) => `- ${violation.path}: ${violation.reason}`)];
	throw new Error(lines.join("\n"));
}
//#endregion
export { assertNoOAuthSecretRefPolicyViolations as t };
