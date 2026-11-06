import Foundation
import OSLog

extension GatewayNodeSession {
    private struct McpQuestionGrant: Decodable {
        let elicitationId: UUID
    }

    /// Time allowed for a human answer, matching the node's `MCP_ELICITATION_TIMEOUT_MS`.
    private static let mcpElicitationTimeoutMs = 600_000

    static func invokeWallTimeoutMs(for request: BridgeInvokeRequest, timeoutMs: Int?) -> Int {
        let workTimeout = timeoutMs.map { min(max(0, $0), Self.maxInvokeTimeoutMs) } ?? Self.defaultInvokeTimeoutMs
        guard workTimeout > 0,
              request.command == "mcp.tools.call.v1",
              let paramsJSON = request.paramsJSON,
              (try? JSONDecoder().decode(McpQuestionGrant.self, from: Data(paramsJSON.utf8))) != nil
        else { return workTimeout }
        // Only the outer clock includes human input. The node receives the original active-work timeout.
        return workTimeout + min(Self.mcpElicitationTimeoutMs, Self.maxInvokeTimeoutMs - workTimeout)
    }

    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onOperationSettled: (@Sendable () async -> Void)? = nil) async -> BridgeInvokeResponse
    {
        let timeoutLogger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
        let timeout = Self.invokeWallTimeoutMs(for: request, timeoutMs: timeoutMs)
        guard timeout > 0 else {
            let response = await onInvoke(request)
            await onOperationSettled?()
            return response
        }

        // Keep the wrapper detached: this nonthrowing API historically lets the invoke/timeout
        // race settle even when its caller is cancelled.
        return await Task.detached {
            await (try? AsyncTimeout.withTimeoutMs(
                timeoutMs: timeout,
                onTimeout: {
                    timeoutLogger.info("node invoke timeout fired id=\(request.id, privacy: .public)")
                    return CancellationError()
                },
                operation: {
                    let response = await onInvoke(request)
                    await onOperationSettled?()
                    return response
                })) ?? BridgeInvokeResponse(
                id: request.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "node invoke timed out"))
        }.value
    }
}
