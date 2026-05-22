//#region src/shared/number-coercion.ts
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
//#endregion
export { asFiniteNumber as t };
