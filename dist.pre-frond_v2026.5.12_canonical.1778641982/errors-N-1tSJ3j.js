//#region src/acp/runtime/errors.ts
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
function isAcpRuntimeError(value) {
	return value instanceof AcpRuntimeError || getForeignAcpRuntimeError(value) !== null;
}
function toAcpRuntimeError(params) {
	if (params.error instanceof AcpRuntimeError) return params.error;
	const foreignAcpRuntimeError = getForeignAcpRuntimeError(params.error);
	if (foreignAcpRuntimeError) return new AcpRuntimeError(foreignAcpRuntimeError.code, foreignAcpRuntimeError.message, { cause: params.error });
	if (params.error instanceof Error) return new AcpRuntimeError(params.fallbackCode, params.error.message, { cause: params.error });
	return new AcpRuntimeError(params.fallbackCode, params.fallbackMessage, { cause: params.error });
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
export { withAcpRuntimeErrorBoundary as a, toAcpRuntimeError as i, AcpRuntimeError as n, isAcpRuntimeError as r, ACP_ERROR_CODES as t };
