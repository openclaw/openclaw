import { lt as secretRefKey, x as resolveSecretRefValues } from "./auth-profiles-C39jSzPb.js";
import { L as resolveSecretInputRef } from "./registry-DTmGzx3d.js";

//#region src/gateway/resolve-configured-secret-input-string.ts
function trimToUndefined(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function buildUnresolvedReason(params) {
	if (params.style === "generic") return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
	if (params.kind === "non-string") return `${params.path} SecretRef resolved to a non-string value.`;
	if (params.kind === "empty") return `${params.path} SecretRef resolved to an empty value.`;
	return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}
async function resolveConfiguredSecretInputString(params) {
	const style = params.unresolvedReasonStyle ?? "generic";
	const { ref } = resolveSecretInputRef({
		value: params.value,
		defaults: params.config.secrets?.defaults
	});
	if (!ref) return { value: trimToUndefined(params.value) };
	const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
	try {
		const resolvedValue = (await resolveSecretRefValues([ref], {
			config: params.config,
			env: params.env
		})).get(secretRefKey(ref));
		if (typeof resolvedValue !== "string") return { unresolvedRefReason: buildUnresolvedReason({
			path: params.path,
			style,
			kind: "non-string",
			refLabel
		}) };
		const trimmed = resolvedValue.trim();
		if (trimmed.length === 0) return { unresolvedRefReason: buildUnresolvedReason({
			path: params.path,
			style,
			kind: "empty",
			refLabel
		}) };
		return { value: trimmed };
	} catch {
		return { unresolvedRefReason: buildUnresolvedReason({
			path: params.path,
			style,
			kind: "unresolved",
			refLabel
		}) };
	}
}

//#endregion
export { resolveConfiguredSecretInputString as t };