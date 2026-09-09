import Foundation
import OpenClawChatUI

extension MacGatewayChatTransport {
    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                let data = try await request(OpenClawChatGatewayRequests.agentsList())
                return try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
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

    func acquireSessionGroupsRouteLease(agentID: String?) async -> OpenClawChatSessionGroupsRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
        let owner: String
        if let agentID {
            owner = agentID
        } else {
            guard let data = try? await request(OpenClawChatGatewayRequests.agentsList()),
                  let agents = try? OpenClawChatGatewayPayloadCodec.decodeAgentsList(data),
                  agents.selectionRequired != true
            else { return nil }
            owner = agents.defaultId
        }
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: {
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsList(agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
            },
            putGroups: { names in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(names: names, agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            renameGroup: { name, to in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsRename(name: name, to: to, agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            deleteGroup: { name in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsDelete(name: name, agentID: owner))
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
            request: { request in
                try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            })
    }

    func requestChatSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard let serverLease = await self.connection.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await self.requireCurrentOutboxGateway()
        return try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: serverLease)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID,
            fromLastCompleted: fromLastCompleted)
        let data = try await self.requestChatSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data).key
    }
}
