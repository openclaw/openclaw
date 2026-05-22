import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-D3K0qXmL.js";
import "./error-runtime-SIsXIOqW.js";
import "./string-coerce-runtime-D_6kqRly.js";
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
