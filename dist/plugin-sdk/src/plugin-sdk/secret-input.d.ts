import { z } from "zod";
import { hasConfiguredSecretInput, isSecretRef, coerceSecretRef, resolveSecretInputString, normalizeResolvedSecretInputString, normalizeSecretInputString } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { buildSecretInputSchema } from "./secret-input-schema.js";
export type { SecretInput, SecretInputStringResolution, SecretInputStringResolutionMode, } from "../config/types.secrets.js";
export { buildSecretInputSchema, coerceSecretRef, hasConfiguredSecretInput, isSecretRef, resolveSecretInputString, normalizeResolvedSecretInputString, normalizeSecretInput, normalizeSecretInputString, };
/** Optional version of the shared secret-input schema. */
export declare function buildOptionalSecretInputSchema(): z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
    source: z.ZodLiteral<"env">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    source: z.ZodLiteral<"file">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    source: z.ZodLiteral<"exec">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>], "source">]>>;
/** Array version of the shared secret-input schema. */
export declare function buildSecretInputArraySchema(): z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
    source: z.ZodLiteral<"env">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    source: z.ZodLiteral<"file">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    source: z.ZodLiteral<"exec">;
    provider: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>], "source">]>>;
