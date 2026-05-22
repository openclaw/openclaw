//#region src/commands/models/list.errors.ts
const MODEL_AVAILABILITY_UNAVAILABLE_CODE = "MODEL_AVAILABILITY_UNAVAILABLE";
function formatErrorWithStack(err) {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}
function shouldFallbackToAuthHeuristics(err) {
	if (!(err instanceof Error)) return false;
	return err.code === MODEL_AVAILABILITY_UNAVAILABLE_CODE;
}
//#endregion
export { formatErrorWithStack as n, shouldFallbackToAuthHeuristics as r, MODEL_AVAILABILITY_UNAVAILABLE_CODE as t };
