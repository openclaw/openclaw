import { i as parseDotPath, s as toDotPath } from "./shared-Cv5g0_Ch.js";
import { c as resolvePlanTargetAgainstRegistry } from "./target-registry-t5xykQQS.js";
import { c as isValidSecretProviderAlias, o as isValidExecSecretRefId } from "./ref-contract-D_h_G00C.js";
import { w as SecretProviderSchema } from "./zod-schema.core-D7Y_eqdd.js";
//#region src/secrets/plan.ts
const FORBIDDEN_PATH_SEGMENTS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isObjectRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSecretProviderConfigShape(value) {
	return SecretProviderSchema.safeParse(value).success;
}
function hasForbiddenPathSegment(segments) {
	return segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}
function resolveValidatedPlanTarget(candidate) {
	if (typeof candidate.type !== "string" || !candidate.type.trim()) return null;
	const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
	if (!path) return null;
	const segments = Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0 ? candidate.pathSegments.map((segment) => segment.trim()).filter(Boolean) : parseDotPath(path);
	if (segments.length === 0 || hasForbiddenPathSegment(segments) || path !== toDotPath(segments)) return null;
	return resolvePlanTargetAgainstRegistry({
		type: candidate.type,
		pathSegments: segments,
		providerId: candidate.providerId,
		accountId: candidate.accountId
	});
}
function isSecretsApplyPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const typed = value;
	if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) return false;
	for (const target of typed.targets) {
		if (!target || typeof target !== "object") return false;
		const candidate = target;
		const ref = candidate.ref;
		const resolved = resolveValidatedPlanTarget({
			type: candidate.type,
			path: candidate.path,
			pathSegments: candidate.pathSegments,
			agentId: candidate.agentId,
			providerId: candidate.providerId,
			accountId: candidate.accountId,
			authProfileProvider: candidate.authProfileProvider
		});
		if (typeof candidate.path !== "string" || !candidate.path.trim() || candidate.pathSegments !== void 0 && !Array.isArray(candidate.pathSegments) || !resolved || !ref || typeof ref !== "object" || ref.source !== "env" && ref.source !== "file" && ref.source !== "exec" || typeof ref.provider !== "string" || ref.provider.trim().length === 0 || typeof ref.id !== "string" || ref.id.trim().length === 0 || ref.source === "exec" && !isValidExecSecretRefId(ref.id)) return false;
		if (resolved.entry.configFile === "auth-profiles.json") {
			if (typeof candidate.agentId !== "string" || candidate.agentId.trim().length === 0) return false;
			if (candidate.authProfileProvider !== void 0 && (typeof candidate.authProfileProvider !== "string" || candidate.authProfileProvider.trim().length === 0)) return false;
		}
	}
	if (typed.providerUpserts !== void 0) {
		if (!isObjectRecord(typed.providerUpserts)) return false;
		for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
			if (!isValidSecretProviderAlias(providerAlias)) return false;
			if (!isSecretProviderConfigShape(providerValue)) return false;
		}
	}
	if (typed.providerDeletes !== void 0) {
		if (!Array.isArray(typed.providerDeletes) || typed.providerDeletes.some((providerAlias) => typeof providerAlias !== "string" || !isValidSecretProviderAlias(providerAlias))) return false;
	}
	return true;
}
function normalizeSecretsPlanOptions(options) {
	return {
		scrubEnv: options?.scrubEnv ?? true,
		scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
		scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true
	};
}
//#endregion
export { normalizeSecretsPlanOptions as n, resolveValidatedPlanTarget as r, isSecretsApplyPlan as t };
