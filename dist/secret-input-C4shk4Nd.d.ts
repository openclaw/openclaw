import { B as ZodLiteral, Q as ZodOptional, Z as ZodObject, bt as ZodUnion, r as ZodArray, ra as $strip, st as ZodString, y as ZodDiscriminatedUnion } from "./schemas-CkRCGSfd.js";

//#region src/plugin-sdk/secret-input-schema.d.ts
declare function buildSecretInputSchema(): ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
  source: ZodLiteral<"env">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"file">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"exec">;
  provider: ZodString;
  id: ZodString;
}, $strip>], "source">]>;
//#endregion
//#region src/plugin-sdk/secret-input.d.ts
/** Optional version of the shared secret-input schema. */
declare function buildOptionalSecretInputSchema(): ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
  source: ZodLiteral<"env">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"file">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"exec">;
  provider: ZodString;
  id: ZodString;
}, $strip>], "source">]>>;
/** Array version of the shared secret-input schema. */
declare function buildSecretInputArraySchema(): ZodArray<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
  source: ZodLiteral<"env">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"file">;
  provider: ZodString;
  id: ZodString;
}, $strip>, ZodObject<{
  source: ZodLiteral<"exec">;
  provider: ZodString;
  id: ZodString;
}, $strip>], "source">]>>;
//#endregion
export { buildSecretInputArraySchema as n, buildSecretInputSchema as r, buildOptionalSecretInputSchema as t };