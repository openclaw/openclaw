import Foundation
import OpenClawChatUI

extension MacGatewayChatTransport {
    func loadAgents(onUpdate: @escaping OpenClawChatAgentCatalogUpdate) async throws {
        // The window's first catalog load can precede its event subscription connecting.
        let serverLease = try await self.connection.acquireServerLease()
        try await self.requireCurrentOutboxGateway()
        try await self.loadAgents(ifCurrentServerLease: serverLease, onUpdate: onUpdate)
    }

    private func loadAgents(
        ifCurrentServerLease serverLease: GatewayConnection.ServerLease,
        onUpdate: OpenClawChatAgentCatalogUpdate) async throws
    {
        try await OpenClawChatAgentsListResponse.load(
            request: { request in
                try await self.connection.request(
                    request,
                    ifCurrentServerLease: serverLease)
            },
            isCurrent: { await self.connection.isCurrentServerLease(serverLease) },
            onUpdate: onUpdate)
    }

    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                request,
                ifCurrentServerLease: serverLease)
        }
        return OpenClawChatNewSessionRouteLease(
            loadAgents: { onUpdate in
                try await self.loadAgents(ifCurrentServerLease: serverLease, onUpdate: onUpdate)
            },
            createSession: { key, label, explicitAgentID, parentSessionKey, worktree, worktreeBaseRef in
                let agentID = explicitAgentID
                    ?? OpenClawChatSessionKey.agentID(from: key)
                    ?? parentSessionKey.flatMap { OpenClawChatSessionKey.agentID(from: $0) }
                let createRequest = OpenClawChatGatewayRequests.createSession(
                    key: key,
                    agentID: agentID,
                    label: label,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
            })
    }

    func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                request,
                ifCurrentServerLease: serverLease)
        }
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: {
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsList())
                return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
            },
            putGroups: { names in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(names: names))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            renameGroup: { name, to in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsRename(name: name, to: to))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            deleteGroup: { name in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsDelete(name: name))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            })
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let unreadAckContract = await self.connection.supportsServerCapability(
            .sessionUnreadAckContract,
            ifCurrentServerLease: serverLease)
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            sessionTarget: { transport.sessionTarget(for: $0) },
            unreadAckContract: unreadAckContract,
            receivesPatchReceipts: true,
            request: { request in
                try await self.connection.request(
                    request,
                    ifCurrentServerLease: serverLease)
            })
    }

    func requestChatSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard let serverLease = await self.connection.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await self.requireCurrentOutboxGateway()
        return try await self.connection.request(
            request,
            ifCurrentServerLease: serverLease)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: fromLastCompleted, agentID: nil)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool, agentID: String?) async throws -> String {
        let target = self.sessionTarget(for: parentKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID,
            fromLastCompleted: fromLastCompleted)
        let data = try await self.requestChatSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data).key
    }
}
