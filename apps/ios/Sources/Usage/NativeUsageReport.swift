import Foundation

/// Read projections of the existing sessions.usage and usage.status responses.
struct NativeUsageReport: Decodable, Sendable {
    struct Totals: Decodable, Sendable {
        let computedAt: Double?
        let input: Int
        let output: Int
        let cacheRead: Int
        let cacheWrite: Int
        let cacheUnmeasuredInput: Int?
        let totalTokens: Int
        let totalCost: Double?
        let missingCostEntries: Int?

        var recordedCost: Double? {
            guard let totalCost, totalCost != 0 || missingCostEntries == 0 else { return nil }
            return totalCost
        }
    }

    struct Day: Decodable, Identifiable, Sendable {
        let date: String
        let totalTokens: Int
        let totalCost: Double?
        let missingCostEntries: Int?
        var id: String {
            self.date
        }

        var recordedCost: Double? {
            guard let totalCost, totalCost != 0 || missingCostEntries == 0 else { return nil }
            return totalCost
        }
    }

    struct Messages: Decodable, Sendable {
        let total: Int?
        let toolResults: Int?
        let user: Int
        let assistant: Int
        let toolCalls: Int
        let errors: Int
    }

    struct Attribution: Decodable, Sendable {
        let model: String?
        let provider: String?
        let agentId: String?
        let channel: String?
        let totals: Totals
    }

    struct Tools: Decodable, Sendable {
        struct Entry: Decodable, Sendable {
            let name: String
            let count: Int
        }

        let tools: [Entry]
    }

    struct Latency: Decodable, Sendable {
        let avgMs: Double
        let p95Ms: Double
        let timedMs: Double?
        let timedTokens: Double?
    }

    struct Aggregates: Decodable, Sendable {
        let sessionCount: Int?
        let messages: Messages
        let costDaily: [Day]?
        let byModel: [Attribution]
        let byAgent: [Attribution]
        let byProvider: [Attribution]
        let byChannel: [Attribution]
        let tools: Tools
        let latency: Latency?
    }

    struct Overview: Decodable, Sendable {
        let selectedSessionCount: Int
        let total: Int
        let durationMs: Double?
        let durationCount: Int?
    }

    struct Session: Decodable, Identifiable, Sendable {
        let key: String
        let label: String?
        let model: String?
        let usage: Totals?
        var id: String {
            self.key
        }
    }

    struct Partial: Decodable, Sendable { let message: String }
    struct Cache: Decodable, Sendable { let status: String }
    let startDate: String
    let endDate: String
    let totals: Totals
    let aggregates: Aggregates
    let overview: Overview?
    let sessions: [Session]
    let partial: Partial?
    let cacheStatus: Cache?

    var isComplete: Bool {
        self.partial == nil && (self.cacheStatus?.status ?? "fresh") == "fresh"
    }

    /// A cold overview can already list sessions while the Gateway is computing their usage.
    var awaitingUsage: Bool {
        !self.isComplete && self.totals.totalTokens == 0 && (self.totals.totalCost ?? 0) == 0 &&
            !self.sessions
            .contains {
                $0.usage?.computedAt != nil || ($0.usage?.totalTokens ?? 0) > 0 || ($0.usage?.totalCost ?? 0) > 0
            } &&
            !(self.aggregates.costDaily ?? []).contains { $0.totalTokens > 0 || ($0.totalCost ?? 0) > 0 }
    }
}

struct NativeUsagePlans: Decodable, Sendable {
    struct Window: Decodable, Sendable {
        let label: String
        let groupLabel: String?
        let usedPercent: Double
        let resetAt: Double?
    }

    struct Billing: Decodable, Sendable {
        let type: String
        let label: String?
        let unit: String
        let amount: Double?
        let used: Double?
        let limit: Double?

        func format(_ value: Double) -> String {
            let code = self.unit.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if ["USD", "EUR", "GBP", "CNY", "JPY"].contains(code) {
                return value.formatted(.currency(code: code))
            }
            return value.formatted(.number.precision(.fractionLength(0...2))) + " " + self.unit
        }

        var value: String? {
            switch self.type {
            case "budget":
                guard let used, let limit else { return nil }
                return self.format(used) + " / " + self.format(limit)
            case "balance", "spend": return self.amount.map(self.format)
            default: return nil
            }
        }
    }

    struct Provider: Decodable, Sendable {
        let displayName: String
        let plan: String?
        let summary: String?
        let windows: [Window]
        let billing: [Billing]?
        let error: String?
    }

    let providers: [Provider]
    let refreshing: Bool?
}

struct NativeUsageQuery: Equatable, Encodable {
    let startDate: String
    let endDate: String
    let agentId: String?
    let agentScope: String?
    let timeZone: String
    let mode = "specific"
    let groupBy = "family"
    let projection = "overview"
    let limit = 50
    let includeContextWeight = false
    let sort = "tokens"
    let sortDirection = "desc"

    init(start: Date, end: Date, agentID: String?, zone: TimeZone = .current) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        self.startDate = formatter.string(from: start)
        self.endDate = formatter.string(from: end)
        self.timeZone = zone.identifier
        self.agentId = agentID
        self.agentScope = agentID == nil ? "all" : nil
    }
}
