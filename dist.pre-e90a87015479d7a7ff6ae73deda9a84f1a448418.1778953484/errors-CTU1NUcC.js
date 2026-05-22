import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-C5Jbj3g5.js";
import "./string-coerce-runtime-BOK5X0KD.js";
import "./error-runtime-Dls4_bTA.js";
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
