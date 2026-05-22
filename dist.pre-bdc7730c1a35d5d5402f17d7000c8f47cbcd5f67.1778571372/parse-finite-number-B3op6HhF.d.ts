//#region src/infra/parse-finite-number.d.ts
declare function parseFiniteNumber(value: unknown): number | undefined;
declare function parseStrictInteger(value: unknown): number | undefined;
declare function parseStrictPositiveInteger(value: unknown): number | undefined;
declare function parseStrictNonNegativeInteger(value: unknown): number | undefined;
//#endregion
export { parseStrictPositiveInteger as i, parseStrictInteger as n, parseStrictNonNegativeInteger as r, parseFiniteNumber as t };