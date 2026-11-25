import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    func agentsList(timeoutMs: Double = 15000) async throws -> AgentsListResult {
        try await self.requestDecoded(method: .agentsList, timeoutMs: timeoutMs)
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            retryTransportFailures: retryTransportFailures)
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: Route,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentServerLease lease: ServerLease,
        expectedProfileId: String? = nil,
        completionPolicy: GatewayRequestCompletionPolicy = .requireCurrentRoute) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: lease,
            expectedProfileId: expectedProfileId,
            completionPolicy: completionPolicy)
    }
}
