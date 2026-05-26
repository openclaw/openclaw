export declare const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
export declare const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE = "Plugin runtime subagent methods are only available during a gateway request.";
export declare class RequestScopedSubagentRuntimeError extends Error {
    code: string;
    constructor(message?: string);
}
export { collectErrorGraphCandidates, extractErrorCode, formatErrorMessage, formatUncaughtError, readErrorName, } from "../infra/errors.js";
export { isApprovalNotFoundError } from "../infra/approval-errors.ts";
