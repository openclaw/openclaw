import Foundation

extension GatewayChannelActor {
    func _test_setConnectTimeoutSeconds(_ seconds: Double) {
        self.connectTimeoutSeconds = seconds
    }

    func _test_setConnectAttemptFinishedHandler(_ handler: (@Sendable (UUID) -> Void)?) {
        self.testConnectAttemptFinishedHandler = handler
    }

    #if DEBUG
    func _test_setReconnectBackoffMs(_ milliseconds: Double) {
        self.backoffMs = milliseconds
    }

    func _test_reconnectBackoffMs() -> Double {
        self.backoffMs
    }

    func _test_setConnectRunFinishedHandler(_ handler: (@Sendable () -> Void)?) {
        self.testConnectRunFinishedHandler = handler
    }

    func _test_setConnectFailureBackoffWaitHandler(_ handler: (@Sendable () async throws -> Void)?) {
        self.testConnectFailureBackoffWaitHandler = handler
    }

    func _test_setRequestResumedHandler(_ handler: (@Sendable () async -> Void)?) {
        self.testRequestResumedHandler = handler
    }
    #endif

    func _test_pendingRequestCount() -> Int {
        self.pending.count
    }

    func _test_connectWaiterCount() -> Int {
        self.connectWaiters.count
    }
}
