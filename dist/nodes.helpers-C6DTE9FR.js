import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { Ni as ErrorCodes, Pi as errorShape, t as formatValidationErrors } from "./protocol-QC2mQFMN.js";
import { t as formatForLog } from "./ws-log-CjqaGuge.js";
//#region src/gateway/server-json.ts
function safeParseJson(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	try {
		return JSON.parse(trimmed);
	} catch {
		return { payloadJSON: value };
	}
}
//#endregion
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
export { safeParseJson as i, respondUnavailableOnNodeInvokeError as n, respondUnavailableOnThrow as r, respondInvalidParams as t };
