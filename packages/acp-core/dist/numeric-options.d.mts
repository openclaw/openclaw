//#region src/numeric-options.d.ts
declare function resolveIntegerOption(value: number | undefined, fallback: number, params: {
  min: number;
}): number;
//#endregion
export { resolveIntegerOption };