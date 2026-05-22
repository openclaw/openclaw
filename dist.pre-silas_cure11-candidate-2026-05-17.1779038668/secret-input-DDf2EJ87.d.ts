import { z } from "zod";

//#region src/plugin-sdk/secret-input-schema.d.ts
declare function buildSecretInputSchema(): z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strip>], "source">]>;
//#endregion
//#region src/plugin-sdk/secret-input.d.ts
/** Optional version of the shared secret-input schema. */
declare function buildOptionalSecretInputSchema(): z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
declare function buildSecretInputArraySchema(): z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
//#endregion
export { buildSecretInputArraySchema as n, buildSecretInputSchema as r, buildOptionalSecretInputSchema as t };