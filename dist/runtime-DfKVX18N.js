//#region extensions/matrix/src/matrix/client/runtime.ts
function isBunRuntime() {
	return typeof process.versions.bun === "string";
}
//#endregion
export { isBunRuntime as t };
