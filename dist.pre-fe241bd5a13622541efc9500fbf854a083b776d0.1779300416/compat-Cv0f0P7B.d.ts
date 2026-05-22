import { Di as $brand, Fi as $ZodFormattedError, Ii as $ZodIssue, Mi as output, Ni as $ZodErrorMap, Pi as $ZodFlattenedError, Yi as $ZodShape, Zi as $ZodType } from "./schemas-CkRCGSfd.js";

//#region node_modules/zod/v4/classic/compat.d.cts
/** @deprecated Use the raw string literal codes instead, e.g. "invalid_type". */
declare const ZodIssueCode: {
  readonly invalid_type: "invalid_type";
  readonly too_big: "too_big";
  readonly too_small: "too_small";
  readonly invalid_format: "invalid_format";
  readonly not_multiple_of: "not_multiple_of";
  readonly unrecognized_keys: "unrecognized_keys";
  readonly invalid_union: "invalid_union";
  readonly invalid_key: "invalid_key";
  readonly invalid_element: "invalid_element";
  readonly invalid_value: "invalid_value";
  readonly custom: "custom";
};
/** @deprecated Use `z.$ZodFlattenedError` */
type inferFlattenedErrors<T extends $ZodType, U = string> = $ZodFlattenedError<output<T>, U>;
/** @deprecated Use `z.$ZodFormattedError` */
type inferFormattedError<T extends $ZodType<any, any>, U = string> = $ZodFormattedError<output<T>, U>;
/** Use `z.$brand` instead */
type BRAND<T extends string | number | symbol = string | number | symbol> = {
  [$brand]: { [k in T]: true };
};
/** @deprecated Use `z.config(params)` instead. */
declare function setErrorMap(map: $ZodErrorMap): void;
/** @deprecated Use `z.config()` instead. */
declare function getErrorMap(): $ZodErrorMap<$ZodIssue> | undefined;
/** Included for Zod 3 compatibility */
type ZodRawShape = $ZodShape;
/** @deprecated Do not use. Stub definition, only included for zod-to-json-schema compatibility. */
declare enum ZodFirstPartyTypeKind {}
//#endregion
export { getErrorMap as a, setErrorMap as c, ZodRawShape as i, ZodFirstPartyTypeKind as n, inferFlattenedErrors as o, ZodIssueCode as r, inferFormattedError as s, BRAND as t };