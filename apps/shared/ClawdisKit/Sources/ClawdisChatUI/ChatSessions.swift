import Foundation

public struct ClawdisChatSessionsDefaults: Codable, Sendable {
    public let model: String?
    public let contextTokens: Int?
}

public enum ClawdisChatSessionSyncing: Codable, Hashable, Sendable {
    case bool(Bool)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
            return
        }
        if let s = try? container.decode(String.self) {
            self = .string(s)
            return
        }
        throw DecodingError.typeMismatch(
            ClawdisChatSessionSyncing.self,
            DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "Expected Bool or String"))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .bool(b):
            try container.encode(b)
        case let .string(s):
            try container.encode(s)
        }
    }
}

public struct ClawdisChatSessionEntry: Codable, Identifiable, Sendable, Hashable {
    public var id: String { self.key }

    public let key: String
    public let kind: String?
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
    public let syncing: ClawdisChatSessionSyncing?
}

public struct ClawdisChatSessionsListResponse: Codable, Sendable {
    public let ts: Double?
    public let path: String?
    public let count: Int?
    public let defaults: ClawdisChatSessionsDefaults?
    public let sessions: [ClawdisChatSessionEntry]
}

