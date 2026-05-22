import { t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-CL51SR4g.js";
//#region src/secrets/ref-contract.ts
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SINGLE_VALUE_FILE_REF_ID = "value";
const FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN = "~(?:[^01]|$)";
const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN = "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
function secretRefKey(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function resolveDefaultSecretProviderAlias(config, source, options) {
	const configured = source === "env" ? config.secrets?.defaults?.env : source === "file" ? config.secrets?.defaults?.file : config.secrets?.defaults?.exec;
	if (configured?.trim()) return configured.trim();
	if (options?.preferFirstProviderForSource) {
		const providers = config.secrets?.providers;
		if (providers) {
			for (const [providerName, provider] of Object.entries(providers)) if (provider?.source === source) return providerName;
		}
	}
	return DEFAULT_SECRET_PROVIDER_ALIAS;
}
function isValidFileSecretRefId(value) {
	if (value === "value") return true;
	if (!value.startsWith("/")) return false;
	return value.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}
function isValidSecretProviderAlias(value) {
	return SECRET_PROVIDER_ALIAS_PATTERN.test(value);
}
function validateExecSecretRefId(value) {
	if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) return {
		ok: false,
		reason: "pattern"
	};
	for (const segment of value.split("/")) if (segment === "." || segment === "..") return {
		ok: false,
		reason: "traversal-segment"
	};
	return { ok: true };
}
function isValidExecSecretRefId(value) {
	return validateExecSecretRefId(value).ok;
}
function formatExecSecretRefIdValidationMessage() {
	return [
		"Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/",
		"and must not include \".\" or \"..\" path segments",
		"(example: \"vault/openai/api-key\")."
	].join(" ");
}
//#endregion
export { formatExecSecretRefIdValidationMessage as a, isValidSecretProviderAlias as c, validateExecSecretRefId as d, SINGLE_VALUE_FILE_REF_ID as i, resolveDefaultSecretProviderAlias as l, FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN as n, isValidExecSecretRefId as o, SECRET_PROVIDER_ALIAS_PATTERN as r, isValidFileSecretRefId as s, EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN as t, secretRefKey as u };
