//#region src/shared/number-coercion.ts
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asPositiveSafeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
//#endregion
export { asPositiveSafeInteger as n, asFiniteNumber as t };
