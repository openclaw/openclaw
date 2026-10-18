import Foundation
import OpenClawKit

extension GatewayConnectionController {
    func prepareGatewayIngress(
        route: GatewayIngressController.Route,
        userInitiated: Bool,
        admissionCheckpoint: UInt64,
        canRetry: @MainActor () -> Bool) async throws -> GatewayIngressAuthorization?
    {
        // Active handoff and fleet reconciliation both need preflight before native loops
        // exist. Retry inside their existing tasks with one policy and capped backoff.
        var retrySeconds = 1
        while true {
            do {
                return try await self.ingress.prepare(
                    route: route,
                    userInitiated: userInitiated,
                    admissionCheckpoint: admissionCheckpoint)
            } catch {
                let recoverable: Bool = if let accessError = error as? CloudflareAccessError,
                                           case .connectionFailed = accessError
                {
                    true
                } else if let problem = GatewayConnectionProblemMapper.map(error: error) {
                    problem.owner == .network && problem.retryable &&
                        !problem.pauseReconnect && problem.kind != .websocketCancelled
                } else {
                    false
                }
                guard !userInitiated, recoverable, canRetry() else { throw error }
                try await self.autoConnectRetryDelay(.seconds(retrySeconds))
                guard canRetry() else { throw CancellationError() }
                retrySeconds = min(retrySeconds * 2, 30)
            }
        }
    }

    func failGatewayIngressPreparation(
        _ error: Error,
        stableID: String,
        url: URL,
        expectedGeneration: UInt64)
    {
        guard let appModel, appModel.gatewayConnectGeneration == expectedGeneration else { return }
        if error is CancellationError {
            // The ingress owner retains sign-in guidance; cancellation is not a network failure.
            appModel.gatewayStatusText = "Offline"
            return
        }
        let problem = GatewayConnectionProblemMapper.map(error: error) ?? GatewayConnectionProblem(
            kind: .unknown,
            owner: .network,
            title: "Connection check failed",
            message: error.localizedDescription,
            actionLabel: "Retry",
            retryable: true,
            pauseReconnect: false)
        appModel.failGatewayPreconnectVerification(
            problem, stableID: stableID, host: url.host, expectedGeneration: expectedGeneration)
    }
}
