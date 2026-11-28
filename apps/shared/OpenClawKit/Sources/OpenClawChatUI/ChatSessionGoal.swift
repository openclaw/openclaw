import Foundation

/// The chat's Goal, as the session row projects it (packages/gateway-protocol/src/schema/sessions-goal.ts).
/// Decoding is lenient field by field: a Goal shape this build does not know never drops the whole row.
public struct OpenClawChatSessionGoal: Codable, Sendable, Hashable {
    public enum Status: String, Sendable, Hashable {
        case active
        case paused
        case blocked
        case usageLimited = "usage_limited"
        case budgetLimited = "budget_limited"
        case complete
    }

    public let id: String?
    public let objective: String?
    public let statusValue: String?
    public let createdAt: Double?
    public let updatedAt: Double?
    public let tokensUsed: Double?
    public let tokenBudget: Double?
    public let lastStatusNote: String?
    public let pausedAt: Double?
    public let blockedAt: Double?
    public let completedAt: Double?
    public let usageLimitedAt: Double?
    public let budgetLimitedAt: Double?

    public var status: Status? {
        self.statusValue.flatMap(Status.init(rawValue:))
    }

    /// A Goal the chat can show: it has an identity, an objective and a known state.
    public var isPresentable: Bool {
        self.id?.isEmpty == false && self.status != nil && self.objective != nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, objective, createdAt, updatedAt, tokensUsed, tokenBudget, lastStatusNote
        case pausedAt, blockedAt, completedAt, usageLimitedAt, budgetLimitedAt
        case statusValue = "status"
    }

    public init(
        id: String,
        objective: String,
        status: Status,
        createdAt: Double,
        updatedAt: Double,
        tokensUsed: Double = 0,
        tokenBudget: Double? = nil,
        lastStatusNote: String? = nil,
        statusAt: Double? = nil)
    {
        self.id = id
        self.objective = objective
        self.statusValue = status.rawValue
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.tokensUsed = tokensUsed
        self.tokenBudget = tokenBudget
        self.lastStatusNote = lastStatusNote
        self.pausedAt = status == .paused ? statusAt : nil
        self.blockedAt = status == .blocked ? statusAt : nil
        self.completedAt = status == .complete ? statusAt : nil
        self.usageLimitedAt = status == .usageLimited ? statusAt : nil
        self.budgetLimitedAt = status == .budgetLimited ? statusAt : nil
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func value<T: Decodable>(_ key: CodingKeys) -> T? {
            guard let value = try? container.decodeIfPresent(T.self, forKey: key) else { return nil }
            return value
        }
        self.id = value(.id)
        self.objective = value(.objective)
        self.statusValue = value(.statusValue)
        self.createdAt = value(.createdAt)
        self.updatedAt = value(.updatedAt)
        self.tokensUsed = value(.tokensUsed)
        self.tokenBudget = value(.tokenBudget)
        self.lastStatusNote = value(.lastStatusNote)
        self.pausedAt = value(.pausedAt)
        self.blockedAt = value(.blockedAt)
        self.completedAt = value(.completedAt)
        self.usageLimitedAt = value(.usageLimitedAt)
        self.budgetLimitedAt = value(.budgetLimitedAt)
    }

    /// When the Goal left the active state, so a stopped Goal's time stops there (src/shared/session-goal-display.ts).
    public var statusChangedAt: Double? {
        switch self.status {
        case .paused: self.pausedAt ?? self.updatedAt
        case .blocked: self.blockedAt ?? self.updatedAt
        case .complete: self.completedAt ?? self.updatedAt
        case .usageLimited: self.usageLimitedAt ?? self.updatedAt
        case .budgetLimited: self.budgetLimitedAt ?? self.updatedAt
        case .active, nil: nil
        }
    }
}
