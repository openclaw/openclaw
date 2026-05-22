import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import "./error-runtime-B4bLKqjn.js";
import "./string-coerce-runtime-vNMR229H.js";
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
