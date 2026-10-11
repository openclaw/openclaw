import Foundation
import OpenClawProtocol

struct GatewayConnectFailureBackoff {
    private var milliseconds: Double = 500
    private var retryNotBefore: ContinuousClock.Instant?

    var deadline: ContinuousClock.Instant? {
        self.retryNotBefore
    }

    mutating func clear(deadline: ContinuousClock.Instant) {
        if self.retryNotBefore == deadline {
            self.retryNotBefore = nil
        }
    }

    mutating func record(
        error: Error,
        pendingDeviceTokenRetry: Bool,
        supportedProtocols: ClosedRange<Int>)
    {
        guard !Self.isCancellation(error) else { return }
        if let rejection = error as? GatewayConnectAuthError,
           rejection.isProtocolMismatch(supportedProtocols: supportedProtocols)
        {
            // A subsequent setup probe must receive the rejection, not time out
            // behind a transport backoff left by an incompatible handshake.
            self.reset()
            return
        }
        let delayMs = pendingDeviceTokenRetry ? min(self.milliseconds, 250) : self.milliseconds
        let clock = ContinuousClock()
        self.retryNotBefore = clock.now.advanced(by: .milliseconds(Int64(delayMs.rounded(.up))))
        self.milliseconds = min(self.milliseconds * 2, 30000)
    }

    mutating func reset() {
        self.milliseconds = 500
        self.retryNotBefore = nil
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain &&
            nsError.code == URLError.Code.cancelled.rawValue
    }
}

extension GatewayChannelActor {
    nonisolated static func minimumProtocolVersion(role: String, clientMode: String) -> Int {
        // Node RPC frames stayed compatible across v3/v4. Operator chat surfaces require v4.
        if role == "node", clientMode == "node" {
            return GATEWAY_MIN_NODE_PROTOCOL_VERSION
        }
        return GATEWAY_MIN_PROTOCOL_VERSION
    }

    func waitForConnectFailureBackoff() async throws {
        guard let deadline = self.connectFailureBackoff.deadline else { return }
        // Delay inside the shared connect attempt so callers coalesce before a
        // socket is created instead of starting independent retry bursts.
        let wait = Task {
            #if DEBUG
            if let testConnectFailureBackoffWaitHandler = self.testConnectFailureBackoffWaitHandler {
                try await testConnectFailureBackoffWaitHandler()
                return
            }
            #endif
            let clock = ContinuousClock()
            if clock.now < deadline { try await clock.sleep(until: deadline) }
        }
        self.connectFailureBackoffWaitTask = wait
        defer { self.connectFailureBackoffWaitTask = nil }
        do {
            try await withTaskCancellationHandler { try await wait.value } onCancel: { wait.cancel() }
        } catch is CancellationError {
            // A satisfied path cancels the delay, not the shared connection attempt.
            try Task.checkCancellation()
        }
        self.connectFailureBackoff.clear(deadline: deadline)
    }
}
