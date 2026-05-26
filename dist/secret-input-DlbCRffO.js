import { n as ENV_SECRET_REF_ID_RE } from "./types.secrets-BxqheYvy.js";
import { a as formatExecSecretRefIdValidationMessage, o as isValidExecSecretRefId, r as SECRET_PROVIDER_ALIAS_PATTERN, s as isValidFileSecretRefId } from "./ref-contract-BLk8mcqQ.js";
import { t as sensitive } from "./zod-schema.sensitive-DZxjbqai.js";
import { z } from "zod";
//#region src/plugin-sdk/secret-input-schema.ts
function buildSecretInputSchema() {
	return secretInputSchema;
}
const providerSchema = z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\").");
const secretInputSchema = z.union([z.string(), z.discriminatedUnion("source", [
	z.object({
		source: z.literal("env"),
		provider: providerSchema,
		id: z.string().regex(ENV_SECRET_REF_ID_RE, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
	}),
	z.object({
		source: z.literal("file"),
		provider: providerSchema,
		id: z.string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
	}),
	z.object({
		source: z.literal("exec"),
		provider: providerSchema,
		id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
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
	return z.array(buildSecretInputSchema());
}
//#endregion
export { buildSecretInputArraySchema as n, buildSecretInputSchema as r, buildOptionalSecretInputSchema as t };
