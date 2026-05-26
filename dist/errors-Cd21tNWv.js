import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/matrix/src/matrix/errors.ts
function formatMatrixErrorMessage(err) {
	return formatErrorMessage(err);
}
function formatMatrixErrorReason(err) {
	return normalizeLowercaseStringOrEmpty(formatMatrixErrorMessage(err));
}
function isMatrixNotFoundError(err) {
	const errObj = err;
	if (errObj?.statusCode === 404 || errObj?.body?.errcode === "M_NOT_FOUND") return true;
	const message = formatMatrixErrorReason(err);
	return message.includes("m_not_found") || message.includes("[404]") || message.includes("not found");
}
//#endregion
export { formatMatrixErrorReason as n, isMatrixNotFoundError as r, formatMatrixErrorMessage as t };
