import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension MacGatewayChatTransport {
    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else { return nil }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else { return nil }
        }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await GatewayConnection.shared.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                let data = try await request(OpenClawChatGatewayRequests.agentsList())
                let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
                return OpenClawChatAgentsListResponse(
                    defaultId: result.defaultid,
                    agents: result.agents.map {
                        OpenClawChatAgentChoice(
                            id: $0.id,
                            name: $0.name,
                            workspaceGit: $0.workspacegit)
                    })
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
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else { return nil }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else { return nil }
        }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await GatewayConnection.shared.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
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
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else { return nil }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else { return nil }
        }
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            patchSession: { key, label, category, pinned, archived, unread in
                let target = transport.sessionTarget(for: key)
                let request = OpenClawChatGatewayRequests.patchSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                _ = try await GatewayConnection.shared.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            },
            deleteSession: { key in
                let target = transport.sessionTarget(for: key)
                let request = OpenClawChatGatewayRequests.deleteSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID)
                _ = try await GatewayConnection.shared.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            })
    }

    func forkSession(parentKey: String) async throws -> String {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else {
                throw OpenClawChatTransportSendError.notDispatched
            }
        }
        let target = self.sessionTarget(for: parentKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await GatewayConnection.shared.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: serverLease)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data).key
    }
}
