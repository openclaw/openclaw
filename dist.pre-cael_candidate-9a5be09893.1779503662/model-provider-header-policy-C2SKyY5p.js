import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
//#region src/secrets/model-provider-header-policy.ts
const ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
	"apikey",
	"x-auth-token",
	"auth-token",
	"x-access-token",
	"access-token",
	"x-secret-key",
	"secret-key"
]);
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
	"api-key",
	"apikey",
	"token",
	"secret",
	"password",
	"credential"
];
function isLikelySensitiveModelProviderHeaderName(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (!normalized) return false;
	if (ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized)) return true;
	return SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
//#endregion
export { isLikelySensitiveModelProviderHeaderName as t };
