import Foundation

public struct OpenClawChatModelChoice: Identifiable, Codable, Sendable, Hashable {
    public var id: String { self.modelID }

    public let modelID: String
    public let name: String
    public let provider: String
    public let contextWindow: Int?

    public init(modelID: String, name: String, provider: String, contextWindow: Int?) {
        self.modelID = modelID
        self.name = name
        self.provider = provider
        self.contextWindow = contextWindow
    }

    public var displayLabel: String {
        if self.modelID.contains("/") {
            return self.modelID
        }
        let trimmedProvider = self.provider.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProvider.isEmpty else { return self.modelID }
        return "\(trimmedProvider)/\(self.modelID)"
    }
}

public struct OpenClawChatSessionsDefaults: Codable, Sendable {
    public let model: String?
    public let contextTokens: Int?
}

public struct OpenClawChatSessionEntry: Codable, Identifiable, Sendable, Hashable {
    public var id: String { self.key }

    public let key: String
    public let kind: String?
    public let displayName: String?
    public let surface: String?
    public let subject: String?
    public let room: String?
    public let space: String?
    public let updatedAt: Double?
    public let sessionId: String?

    public let systemSent: Bool?
    public let abortedLastRun: Bool?
    public let thinkingLevel: String?
    public let verboseLevel: String?

    public let inputTokens: Int?
    public let outputTokens: Int?
    public let totalTokens: Int?

    public let model: String?
    public let contextTokens: Int?
}

public struct OpenClawChatSessionsListResponse: Codable, Sendable {
    public let ts: Double?
    public let path: String?
    public let count: Int?
    public let defaults: OpenClawChatSessionsDefaults?
    public let sessions: [OpenClawChatSessionEntry]
}
