import { n as ENV_SECRET_REF_ID_RE } from "./types.secrets-D2HSDKMs.js";
import { Bt as discriminatedUnion, Et as array, Rn as string, Tn as object, Xn as union, dn as literal } from "./schemas-Del5uzR8.js";
import { a as formatExecSecretRefIdValidationMessage, o as isValidExecSecretRefId, r as SECRET_PROVIDER_ALIAS_PATTERN, s as isValidFileSecretRefId } from "./ref-contract-C05tDS4l.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
//#region src/plugin-sdk/secret-input-schema.ts
function buildSecretInputSchema() {
	return secretInputSchema;
}
const providerSchema = string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\").");
const secretInputSchema = union([string(), discriminatedUnion("source", [
	object({
		source: literal("env"),
		provider: providerSchema,
		id: string().regex(ENV_SECRET_REF_ID_RE, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
	}),
	object({
		source: literal("file"),
		provider: providerSchema,
		id: string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
	}),
	object({
		source: literal("exec"),
		provider: providerSchema,
		id: string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
	})
])]).register(sensitive);
//#endregion
//#region src/plugin-sdk/secret-input.ts
/** Optional version of the shared secret-input schema. */
function buildOptionalSecretInputSchema() {
	return buildSecretInputSchema().optional();
}
/** Array version of the shared secret-input schema. */
function buildSecretInputArraySchema() {
	return array(buildSecretInputSchema());
}
//#endregion
export { buildSecretInputArraySchema as n, buildSecretInputSchema as r, buildOptionalSecretInputSchema as t };
