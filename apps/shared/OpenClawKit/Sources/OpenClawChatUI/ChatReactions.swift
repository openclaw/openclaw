import Foundation

public struct OpenClawChatReactionIdentity: Codable, Sendable, Equatable {
    public let id: String
    public let label: String?

    public init(id: String, label: String? = nil) {
        self.id = id
        self.label = label
    }
}

public struct OpenClawChatReactionSummary: Codable, Sendable, Equatable {
    public let emoji: String
    public let count: Int
    public let identities: [OpenClawChatReactionIdentity]

    public init(emoji: String, count: Int, identities: [OpenClawChatReactionIdentity]) {
        self.emoji = emoji
        self.count = count
        self.identities = identities
    }
}

public struct OpenClawChatReactionsListResult: Sendable, Equatable {
    public let sessionID: String
    public let reactions: [String: [OpenClawChatReactionSummary]]

    public init(sessionID: String, reactions: [String: [OpenClawChatReactionSummary]]) {
        self.sessionID = sessionID
        self.reactions = reactions
    }
}

public struct OpenClawChatReactionsSetResult: Sendable, Equatable {
    public let messageID: String
    public let reactions: [OpenClawChatReactionSummary]

    public init(messageID: String, reactions: [OpenClawChatReactionSummary]) {
        self.messageID = messageID
        self.reactions = reactions
    }
}

public struct OpenClawChatReactionEvent: Sendable, Equatable {
    public let sessionKey: String
    public let agentID: String
    public let sessionID: String
    public let messageID: String
    public let reactions: [OpenClawChatReactionSummary]

    public init(
        sessionKey: String,
        agentID: String,
        sessionID: String,
        messageID: String,
        reactions: [OpenClawChatReactionSummary])
    {
        self.sessionKey = sessionKey
        self.agentID = agentID
        self.sessionID = sessionID
        self.messageID = messageID
        self.reactions = reactions
    }
}

public struct OpenClawChatReactionAccess: Sendable, Equatable {
    public let role: String?
    public let scopes: Set<String>?
    public let sessionCap: String?
    public let methods: Set<String>?
    public let userID: String?

    public init(
        role: String?,
        scopes: Set<String>?,
        sessionCap: String?,
        methods: Set<String>?,
        userID: String? = nil)
    {
        self.role = role
        self.scopes = scopes
        self.sessionCap = sessionCap
        self.methods = methods
        self.userID = userID
    }

    public var canList: Bool {
        self.methods?.contains("session.reactions.list") == true
    }

    /// Matches Control UI canReactToSession; a live route lease supplies connection admission.
    public func canReact(
        sharingRole: String?,
        visibility: String?,
        archived: Bool,
        catalog: Bool) -> Bool
    {
        guard let sharingRole, !sharingRole.isEmpty, !archived, !catalog, self.sessionCap != "none",
              self.methods?.contains("session.reactions.set") == true,
              self.role?.trimmingCharacters(in: .whitespacesAndNewlines) == "operator",
              let scopes = self.scopes?.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }),
              scopes.contains("operator.write") || scopes.contains("operator.admin")
        else { return false }
        let visibility = visibility ?? "shared"
        if visibility == "draft" { return sharingRole == "owner" || sharingRole == "admin" }
        if sharingRole != "viewer" { return true }
        return visibility == "shared"
            ? self.sessionCap != "view" && self.sessionCap != "suggest"
            : visibility == "suggest" && self.sessionCap != "view"
    }
}

public struct OpenClawChatReactionsRouteLease: Sendable {
    public let routeID: UUID
    public let access: OpenClawChatReactionAccess
    public let isCurrent: @Sendable () async -> Bool
    private let listRequest: @Sendable (String, String?) async throws -> OpenClawChatReactionsListResult
    private let setRequest: @Sendable (String, String?, String, String, Bool) async throws
        -> OpenClawChatReactionsSetResult

    public init(
        routeID: UUID,
        access: OpenClawChatReactionAccess,
        isCurrent: @escaping @Sendable () async -> Bool,
        list: @escaping @Sendable (String, String?) async throws -> OpenClawChatReactionsListResult,
        set: @escaping @Sendable (String, String?, String, String, Bool) async throws
            -> OpenClawChatReactionsSetResult)
    {
        self.routeID = routeID
        self.access = access
        self.isCurrent = isCurrent
        self.listRequest = list
        self.setRequest = set
    }

    public func list(sessionKey: String, agentID: String?) async throws -> OpenClawChatReactionsListResult {
        guard await self.isCurrent() else { throw CancellationError() }
        let result = try await self.listRequest(sessionKey, agentID)
        guard await self.isCurrent() else { throw CancellationError() }
        return result
    }

    public func set(
        sessionKey: String,
        agentID: String?,
        messageID: String,
        emoji: String,
        remove: Bool) async throws -> OpenClawChatReactionsSetResult
    {
        guard await self.isCurrent() else { throw CancellationError() }
        let result = try await self.setRequest(sessionKey, agentID, messageID, emoji, remove)
        guard await self.isCurrent() else { throw CancellationError() }
        return result
    }
}

public enum OpenClawChatReactionEmoji {
    public static let quick = ["👍", "❤️", "🎉", "👀", "🚀", "😂"]
    /// ICU spelling of the Gateway's single-grapheme emoji sequence rule.
    private static let sequence = try? NSRegularExpression(
        pattern: #"^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|"#
            + #"\x{1F3F4}[\x{E0061}-\x{E007A}]+\x{E007F}|"#
            + #"\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)$"#)

    public static func isValid(_ emoji: String) -> Bool {
        guard emoji.count == 1, emoji.unicodeScalars.count <= 32 else { return false }
        let range = NSRange(emoji.startIndex..., in: emoji)
        return self.sequence?.firstMatch(in: emoji, range: range)?.range == range
    }
}
