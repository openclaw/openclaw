import Foundation

extension ExecHostExecutor {
    static func commandResponse(
        execution: Task<ShellExecutor.ShellResult, Never>) async -> ExecHostResponse
    {
        // Enqueuing stays adjacent to the approval commit; awaiting a detached
        // task alone does not propagate the request's cancellation into it.
        let result = await withTaskCancellationHandler {
            await execution.value
        } onCancel: {
            execution.cancel()
        }
        if let preflightError = result.preflightError {
            return self.errorResponse(
                code: "UNAVAILABLE",
                message: preflightError,
                reason: "approval-required")
        }
        let payload = ExecHostRunResult(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: ExecHostOutputLimiter.truncate(result.stdout),
            stderr: ExecHostOutputLimiter.truncate(result.stderr),
            error: result.errorMessage)
        return ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: true,
            payload: payload,
            error: nil)
    }

    static func cancelledResponse() -> ExecHostResponse {
        self.errorResponse(
            code: "UNAVAILABLE",
            message: "SYSTEM_RUN_CANCELLED: execution cancelled",
            reason: "cancelled")
    }

    static func errorResponse(_ error: ExecHostError, type: String = "response") -> ExecHostResponse {
        ExecHostResponse(
            type: type,
            id: UUID().uuidString,
            ok: false,
            payload: nil,
            error: error)
    }

    static func errorResponse(
        code: String,
        message: String,
        reason: String?) -> ExecHostResponse
    {
        self.errorResponse(ExecHostError(code: code, message: message, reason: reason), type: "exec-res")
    }
}
