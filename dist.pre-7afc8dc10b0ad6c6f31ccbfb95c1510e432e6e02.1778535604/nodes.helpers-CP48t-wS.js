import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { Oi as ErrorCodes, ki as errorShape, t as formatValidationErrors } from "./protocol-BLKEhqRU.js";
import { t as formatForLog } from "./ws-log-qdOXizAX.js";
//#region src/gateway/server-methods/nodes.helpers.ts
function respondInvalidParams(params) {
	params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} params: ${formatValidationErrors(params.validator.errors)}`));
}
async function respondUnavailableOnThrow(respond, fn) {
	try {
		await fn();
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
	}
}
function respondUnavailableOnNodeInvokeError(respond, res) {
	if (res.ok) return true;
	const nodeError = res.error && typeof res.error === "object" ? res.error : null;
	const nodeCode = normalizeOptionalString(nodeError?.code) ?? "";
	const nodeMessage = normalizeOptionalString(nodeError?.message) ?? "node invoke failed";
	const message = nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage;
	respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, message, { details: { nodeError: res.error ?? null } }));
	return false;
}
//#endregion
export { respondUnavailableOnNodeInvokeError as n, respondUnavailableOnThrow as r, respondInvalidParams as t };
