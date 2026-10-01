import Foundation
import OpenClawProtocol

public typealias OpenClawChatAgentCatalogUpdate = @MainActor @Sendable (OpenClawChatAgentsListResponse?) -> Void

public struct OpenClawChatAgentChoice: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String?
    public let emoji: String?
    public let workspaceGit: Bool?

    public init(id: String, name: String? = nil, emoji: String? = nil, workspaceGit: Bool? = nil) {
        self.id = id
        self.name = Self.normalizedName(name)
        self.emoji = Self.textAvatar(emoji)
        self.workspaceGit = workspaceGit
    }

    public var displayName: String {
        Self.normalizedName(self.name) ?? self.id
    }

    public var avatarText: String {
        String((Self.textAvatar(self.emoji) ?? String(self.displayName.prefix(1)).uppercased()).prefix(2))
    }

    static func normalizedName(_ value: String?) -> String? {
        guard let value = ChatPayloadDecoding.trimmedNonEmptyString(value) else { return nil }
        // Match normalizeAssistantIdentity's UTF-16 bound without splitting a surrogate pair.
        return ChatReplyQuote.truncateUTF16Safe(value, limit: 50)
    }

    static func textAvatar(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty, value.utf16.count <= 64,
              !value.contains("\r"), !value.contains("\n"),
              !value.hasPrefix("/"),
              value.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) == nil
        else { return nil }
        // Image data and Gateway paths need an authenticated image loader; never render them as text.
        return value
    }

    func resolving(_ identity: AgentIdentityResult?) -> Self {
        guard let identity, identity.agentid == self.id else { return self }
        return Self(
            id: self.id,
            name: self.name ?? identity.name,
            emoji: self.emoji ?? Self.textAvatar(identity.emoji) ?? Self.textAvatar(identity.avatar),
            workspaceGit: self.workspaceGit)
    }
}

public struct OpenClawChatAgentsListResponse: Codable, Sendable, Equatable {
    public let defaultId: String
    public let agents: [OpenClawChatAgentChoice]
    public let sessionRoutingContract: String?

    public init(
        defaultId: String,
        agents: [OpenClawChatAgentChoice],
        sessionRoutingContract: String? = nil)
    {
        self.defaultId = defaultId
        self.agents = agents
        self.sessionRoutingContract = sessionRoutingContract
    }

    /// Publishes the roster before starting optional identity requests, then each resolved identity.
    /// Requests and currentness checks must retain the same Gateway connection for the entire load.
    public static func load(
        request: @escaping @Sendable (OpenClawChatGatewayRequest) async throws -> Data,
        isCurrent: @Sendable () async -> Bool,
        onUpdate: OpenClawChatAgentCatalogUpdate) async throws
    {
        let data = try await request(OpenClawChatGatewayRequests.agentsList())
        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
        try Task.checkCancellation()
        guard await isCurrent() else { throw CancellationError() }
        await onUpdate(catalog)
        try await withThrowingTaskGroup(of: (Int, OpenClawChatAgentChoice).self) { group in
            for (index, agent) in catalog.agents.enumerated() {
                group.addTask {
                    let data = try? await request(OpenClawChatGatewayRequests.agentIdentity(agentID: agent.id))
                    let identity = data.flatMap { try? JSONDecoder().decode(AgentIdentityResult.self, from: $0) }
                    return (index, agent.resolving(identity))
                }
            }
            var agents = catalog.agents
            for try await (index, agent) in group {
                try Task.checkCancellation()
                guard await isCurrent() else { throw CancellationError() }
                guard agents[index] != agent else { continue }
                agents[index] = agent
                await onUpdate(Self(
                    defaultId: catalog.defaultId,
                    agents: agents,
                    sessionRoutingContract: catalog.sessionRoutingContract))
            }
        }
    }
}
