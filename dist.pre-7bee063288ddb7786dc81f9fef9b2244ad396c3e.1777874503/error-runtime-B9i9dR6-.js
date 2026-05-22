import "./errors-QN8rySzW.js";
//#region src/plugin-sdk/error-runtime.ts
const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE = "Plugin runtime subagent methods are only available during a gateway request.";
var RequestScopedSubagentRuntimeError = class extends Error {
	constructor(message = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE) {
		super(message);
		this.code = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE;
		this.name = "RequestScopedSubagentRuntimeError";
	}
};
//#endregion
export { SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE as n, SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE as r, RequestScopedSubagentRuntimeError as t };
