import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension MacGatewayChatTransport {
    func acquireModelSignInContext(agentID: String?) async -> OpenClawChatModelSignInContext? {
        guard let lease = await self.captureChatServerLease(),
              await self.connection.supportsServerMethod("models.authLogin", ifCurrentServerLease: lease) == true,
              let agentID = agentID ?? self.chatGatewayAgentID
        else { return nil }
        let connection = self.connection
        let transport = self
        return OpenClawChatModelSignInContext(
            agentID: agentID,
            request: { method, params in
                try await transport.requestChatGateway(
                    OpenClawChatGatewayRequest(method: method, params: params, timeoutMs: 26 * 60 * 1000),
                    ifCurrentServerLease: lease)
            },
            closeWizard: { sessionID in
                try await connection.request(
                    method: "wizard.cancel",
                    params: ["sessionId": AnyCodable(sessionID), "closeInput": AnyCodable(true)],
                    timeoutMs: 26 * 60 * 1000,
                    ifCurrentServerLease: lease)
            },
            isCurrent: {
                guard transport.nativeBinding == nil || transport.nativeBindingIsCurrent,
                      await connection.isCurrentServerLease(lease)
                else { return false }
                return transport.nativeBinding == nil || transport.nativeBindingIsCurrent
            })
    }

    func loadModelCatalog(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        let lease: GatewayConnection.ServerLease
        if self.nativeBinding != nil {
            guard let captured = await self.captureChatServerLease() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            lease = captured
        } else {
            lease = try await self.connection.acquireServerLease()
        }
        guard await self.connection.supportsServerCapability(
            .publishedModelCatalog, ifCurrentServerLease: lease) == true
        else {
            return OpenClawChatModelCatalogSnapshot(choices: [], availabilityIsSessionScoped: false)
        }
        let request = OpenClawChatGatewayRequests.modelsList(agentID: agentID, sessionKey: sessionKey)
        let data = try await self.requestChatGateway(request, ifCurrentServerLease: lease)
        return try OpenClawChatGatewayPayloadCodec.decodeModelCatalog(data)
    }
}
