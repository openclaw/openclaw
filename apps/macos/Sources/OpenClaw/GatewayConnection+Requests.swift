import Foundation
import OpenClawChatUI
import OpenClawKit

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
        ifCurrentRoute route: Route?,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        guard let route else {
            return try await self.request(request)
        }
        return try await self.request(
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

    func requestHistory(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: Route?) async throws -> Data
    {
        do {
            return try await self.request(request, ifCurrentRoute: route)
        } catch let error as GatewayResponseError {
            // Gateways through v2026.8.1 reject this optional field. Remove the
            // wire downgrade once the minimum remote Gateway is v2026.8.2.
            guard request.params["inputRunIds"] != nil,
                  error.method == "chat.history", error.code == "INVALID_REQUEST",
                  error.message == "invalid chat.history params: at root: unexpected property 'inputRunIds'"
            else { throw error }
            var params = request.params
            params["inputRunIds"] = nil
            let legacyRequest = OpenClawChatGatewayRequest(
                method: request.method, params: params, timeoutMs: request.timeoutMs)
            return try await self.request(legacyRequest, ifCurrentRoute: route)
        }
    }
}
