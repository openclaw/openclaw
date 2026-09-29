import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension GatewayConnection {
    func updateNativeChatSubscription(
        owner: UUID?,
        target: OpenClawChatSessionTarget?) async throws
    {
        let previous = self.nativeChatSubscriptionTail
        let task = Task { [self] in
            _ = await previous?.result
            // Serialize both intent changes and RPCs. A retiring window cannot remove
            // a subscription that another native window has already acquired.
            if let owner {
                if let target {
                    self.nativeChatSubscriptionOwners[owner] = target
                } else {
                    self.nativeChatSubscriptionOwners.removeValue(forKey: owner)
                }
            }
            let captured = target == nil ? await self.captureServerLease() : try await self.acquireServerLease()
            guard let lease = captured else { return }
            if self.nativeChatSubscriptionLease.map({ self.serverLeaseMatchesCurrentState($0) }) != true {
                self.nativeChatSubscribedScopes = []
            }
            self.nativeChatSubscriptionLease = lease
            // Connecting can publish routing metadata. Resolve every retained intent
            // after admission so cold-start aliases share one subscription owner.
            let desired = Set(self.nativeChatSubscriptionOwners.values.map {
                self.conversationOwnershipScope(sessionKey: $0.sessionKey, agentID: $0.agentID)
            })
            for scope in self.nativeChatSubscribedScopes.subtracting(desired) {
                let request = OpenClawChatGatewayRequest(
                    method: "sessions.messages.unsubscribe",
                    params: ["key": AnyCodable(scope.sessionKey)].merging(
                        scope.agentID.map { ["agentId": AnyCodable($0)] } ?? [:],
                        uniquingKeysWith: { _, new in new }),
                    timeoutMs: 10000)
                _ = try await self.request(
                    request,
                    ifCurrentServerLease: lease)
                self.nativeChatSubscribedScopes.remove(scope)
            }
            for scope in desired.subtracting(self.nativeChatSubscribedScopes) {
                let request = OpenClawChatGatewayRequests.subscribeSessionMessages(
                    sessionKey: scope.sessionKey,
                    agentID: scope.agentID)
                _ = try await self.request(
                    request,
                    ifCurrentServerLease: lease)
                self.nativeChatSubscribedScopes.insert(scope)
            }
        }
        self.nativeChatSubscriptionTail = task
        try await task.value
    }
}
