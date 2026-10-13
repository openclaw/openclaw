import Foundation
import OpenClawChatUI

extension GatewayConnection {
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
        ifCurrentServerLease lease: ServerLease) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: lease)
    }
}
