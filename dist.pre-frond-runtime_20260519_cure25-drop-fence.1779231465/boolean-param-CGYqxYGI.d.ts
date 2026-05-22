//#region src/plugin-sdk/boolean-param.d.ts
/** Read loose boolean params from tool input that may arrive as booleans or "true"/"false" strings. */
declare function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined;
//#endregion
export { readBooleanParam as t };