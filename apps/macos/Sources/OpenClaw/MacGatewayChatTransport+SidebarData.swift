import Foundation
import OpenClawChatUI

extension MacGatewayChatTransport: OpenClawChatSidebarTransport {
    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data {
        let lease = try await self.connection.acquireServerLease()
        try await self.requireCurrentOutboxGateway()
        return { request in
            try await self.connection.request(request, ifCurrentServerLease: lease)
        }
    }

    func snapshotTransportEvent(previousLease: GatewayConnection.ServerLease) async -> OpenClawChatTransportEvent {
        if self.connection.serverLeaseMatchesCurrentRoute(previousLease) { return .reconnected }
        // The cache namespace survives explicit reconnect/token renewal; profile principal changes
        // retire the fleet owner (MacGatewayProfiles.swift), and Primary rechecks its current identity.
        if self.outboxGatewayID != nil, await self.currentOutboxGatewayMatchesConnection() { return .reconnected }
        return .routeChanged
    }
}
