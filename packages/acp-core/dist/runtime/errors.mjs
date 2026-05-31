import { redactSensitiveText, stringifyNonErrorCause } from "../error-format.mjs";
//#region src/runtime/errors.ts
const ACP_ERROR_CODES = [
	"ACP_BACKEND_MISSING",
	"ACP_BACKEND_UNAVAILABLE",
	"ACP_BACKEND_UNSUPPORTED_CONTROL",
	"ACP_DISPATCH_DISABLED",
	"ACP_INVALID_RUNTIME_OPTION",
	"ACP_SESSION_INIT_FAILED",
	"ACP_TURN_FAILED"
];
const ACP_ERROR_CODE_SET = new Set(ACP_ERROR_CODES);
var AcpRuntimeError = class extends Error {
	constructor(code, message, options) {
		super(message);
		this.name = "AcpRuntimeError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function getForeignAcpRuntimeError(value) {
	if (!(value instanceof Error)) return null;
	const code = value.code;
	if (typeof code !== "string" || !ACP_ERROR_CODE_SET.has(code)) return null;
	return {
		code,
		message: value.message
	};
}
function readAcpRequestErrorDetails(value) {
	if (typeof value.code !== "number") return;
	const data = value.data;
	if (!data || typeof data !== "object") return;
	const details = data.details;
	if (details === void 0 || details === null) return;
	const rendered = redactSensitiveText(stringifyNonErrorCause(details)).trim();
	return rendered.length > 0 ? rendered : void 0;
}
function messageWithAcpRequestErrorDetails(error) {
	const details = readAcpRequestErrorDetails(error);
	if (!details || error.message.includes(details)) return error.message;
	return `${error.message}: ${details}`;
}
function isAcpRuntimeError(value) {
	return value instanceof AcpRuntimeError || getForeignAcpRuntimeError(value) !== null;
}
function toAcpRuntimeError(params) {
	if (params.error instanceof AcpRuntimeError) return params.error;
	const foreignAcpRuntimeError = getForeignAcpRuntimeError(params.error);
	if (foreignAcpRuntimeError) return new AcpRuntimeError(foreignAcpRuntimeError.code, foreignAcpRuntimeError.message, { cause: params.error });
	if (params.error instanceof Error) return new AcpRuntimeError(params.fallbackCode, messageWithAcpRequestErrorDetails(params.error), { cause: params.error });
	return new AcpRuntimeError(params.fallbackCode, params.fallbackMessage, { cause: params.error });
}
/**
* Render an error and its `.cause` chain as a single human-readable line for
* logs, lifecycle events, and tool results. Format is
* `Name [code]: message <- Name [code]: message <- ...`. Number codes also
* appear, so JSON-RPC error codes like `-32603` survive into surfaces that
* downstream consumers see (gateway logs, telegram replies, tool_result text).
*
* Depth is capped to defend against self-referential `.cause` cycles.
*/
function formatAcpErrorChain(error) {
	if (!(error instanceof Error)) return redactSensitiveText(String(error));
	const segments = [renderSingleError(error)];
	let current = error.cause;
	let depth = 0;
	while (current !== void 0 && current !== null && depth < 8) {
		if (current instanceof Error) {
			segments.push(renderSingleError(current));
			current = current.cause;
		} else {
			segments.push(stringifyNonErrorCause(current));
			current = void 0;
		}
		depth += 1;
	}
	return redactSensitiveText(segments.join(" <- "));
}
function renderSingleError(error) {
	const codeValue = error.code;
	const codeSuffix = typeof codeValue === "string" || typeof codeValue === "number" ? ` [${codeValue}]` : "";
	return `${error.name}${codeSuffix}: ${error.message}`;
}
async function withAcpRuntimeErrorBoundary(params) {
	try {
		return await params.run();
	} catch (error) {
		throw toAcpRuntimeError({
			error,
			fallbackCode: params.fallbackCode,
			fallbackMessage: params.fallbackMessage
		});
	}
}
//#endregion
export { ACP_ERROR_CODES, AcpRuntimeError, formatAcpErrorChain, isAcpRuntimeError, toAcpRuntimeError, withAcpRuntimeErrorBoundary };
