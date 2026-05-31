//#region src/meta.d.ts
declare function readString(meta: Record<string, unknown> | null | undefined, keys: string[]): string | undefined;
declare function readBool(meta: Record<string, unknown> | null | undefined, keys: string[]): boolean | undefined;
declare function readNumber(meta: Record<string, unknown> | null | undefined, keys: string[]): number | undefined;
declare function readNonNegativeInteger(meta: Record<string, unknown> | null | undefined, keys: string[]): number | undefined;
//#endregion
export { readBool, readNonNegativeInteger, readNumber, readString };