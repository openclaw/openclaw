import Foundation

enum CronSessionTarget: CaseIterable, Identifiable, Codable, Equatable, Hashable {
    case main
    case isolated
    case current
    case unknown(String)

    static var allCases: [CronSessionTarget] {
        [.main, .isolated, .current]
    }

    var rawValue: String {
        switch self {
        case .main: "main"
        case .isolated: "isolated"
        case .current: "current"
        case let .unknown(value): value
        }
    }

    var id: String {
        self.rawValue
    }

    init(rawValue: String) {
        switch rawValue {
        case "main":
            self = .main
        case "isolated":
            self = .isolated
        case "current":
            self = .current
        default:
            self = .unknown(rawValue)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = .init(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(self.rawValue)
    }
}

enum CronWakeMode: CaseIterable, Identifiable, Codable, Equatable, Hashable {
    case now
    case nextHeartbeat
    case unknown(String)

    static var allCases: [CronWakeMode] {
        [.now, .nextHeartbeat]
    }

    var rawValue: String {
        switch self {
        case .now: "now"
        case .nextHeartbeat: "next-heartbeat"
        case let .unknown(value): value
        }
    }

    var id: String {
        self.rawValue
    }

    init(rawValue: String) {
        switch rawValue {
        case "now":
            self = .now
        case "next-heartbeat":
            self = .nextHeartbeat
        default:
            self = .unknown(rawValue)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = .init(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(self.rawValue)
    }
}

enum CronDeliveryMode: CaseIterable, Identifiable, Codable, Equatable, Hashable {
    case none
    case announce
    case webhook
    case raw
    case unknown(String)

    static var allCases: [CronDeliveryMode] {
        [.none, .announce, .webhook]
    }

    var rawValue: String {
        switch self {
        case .none: "none"
        case .announce: "announce"
        case .webhook: "webhook"
        case .raw: "raw"
        case let .unknown(value): value
        }
    }

    var id: String {
        self.rawValue
    }

    init(rawValue: String) {
        switch rawValue {
        case "none":
            self = .none
        case "announce":
            self = .announce
        case "webhook":
            self = .webhook
        case "raw":
            self = .raw
        default:
            self = .unknown(rawValue)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = .init(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(self.rawValue)
    }
}

struct CronDelivery: Codable, Equatable {
    var mode: CronDeliveryMode
    var channel: String?
    var to: String?
    var bestEffort: Bool?
}

enum CronSchedule: Codable, Equatable {
    case at(at: String)
    case every(everyMs: Int, anchorMs: Int?)
    case cron(expr: String, tz: String?)

    enum CodingKeys: String, CodingKey { case kind, at, atMs, everyMs, anchorMs, expr, tz }

    var kind: String {
        switch self {
        case .at: "at"
        case .every: "every"
        case .cron: "cron"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "at":
            if let at = try container.decodeIfPresent(String.self, forKey: .at),
               !at.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                self = .at(at: at)
                return
            }
            if let atMs = try container.decodeIfPresent(Int.self, forKey: .atMs) {
                let date = Date(timeIntervalSince1970: TimeInterval(atMs) / 1000)
                self = .at(at: Self.formatIsoDate(date))
                return
            }
            throw DecodingError.dataCorruptedError(
                forKey: .at,
                in: container,
                debugDescription: "Missing schedule.at")
        case "every":
            self = try .every(
                everyMs: container.decode(Int.self, forKey: .everyMs),
                anchorMs: container.decodeIfPresent(Int.self, forKey: .anchorMs))
        case "cron":
            self = try .cron(
                expr: container.decode(String.self, forKey: .expr),
                tz: container.decodeIfPresent(String.self, forKey: .tz))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown schedule kind: \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.kind, forKey: .kind)
        switch self {
        case let .at(at):
            try container.encode(at, forKey: .at)
        case let .every(everyMs, anchorMs):
            try container.encode(everyMs, forKey: .everyMs)
            try container.encodeIfPresent(anchorMs, forKey: .anchorMs)
        case let .cron(expr, tz):
            try container.encode(expr, forKey: .expr)
            try container.encodeIfPresent(tz, forKey: .tz)
        }
    }

    static func parseAtDate(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if let date = makeIsoFormatter(withFractional: true).date(from: trimmed) { return date }
        return self.makeIsoFormatter(withFractional: false).date(from: trimmed)
    }

    static func formatIsoDate(_ date: Date) -> String {
        self.makeIsoFormatter(withFractional: false).string(from: date)
    }

    private static func makeIsoFormatter(withFractional: Bool) -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = withFractional
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]
        return formatter
    }
}

enum CronPayload: Codable, Equatable {
    case systemEvent(text: String)
    case agentTurn(
        message: String,
        thinking: String?,
        timeoutSeconds: Int?,
        deliver: Bool?,
        channel: String?,
        to: String?,
        bestEffortDeliver: Bool?)

    enum CodingKeys: String, CodingKey {
        case kind, text, message, thinking, timeoutSeconds, deliver, channel, provider, to, bestEffortDeliver
    }

    var kind: String {
        switch self {
        case .systemEvent: "systemEvent"
        case .agentTurn: "agentTurn"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "systemEvent":
            self = try .systemEvent(text: container.decode(String.self, forKey: .text))
        case "agentTurn":
            self = try .agentTurn(
                message: container.decode(String.self, forKey: .message),
                thinking: container.decodeIfPresent(String.self, forKey: .thinking),
                timeoutSeconds: container.decodeIfPresent(Int.self, forKey: .timeoutSeconds),
                deliver: container.decodeIfPresent(Bool.self, forKey: .deliver),
                channel: container.decodeIfPresent(String.self, forKey: .channel)
                    ?? container.decodeIfPresent(String.self, forKey: .provider),
                to: container.decodeIfPresent(String.self, forKey: .to),
                bestEffortDeliver: container.decodeIfPresent(Bool.self, forKey: .bestEffortDeliver))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown payload kind: \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.kind, forKey: .kind)
        switch self {
        case let .systemEvent(text):
            try container.encode(text, forKey: .text)
        case let .agentTurn(message, thinking, timeoutSeconds, deliver, channel, to, bestEffortDeliver):
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(thinking, forKey: .thinking)
            try container.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
            try container.encodeIfPresent(deliver, forKey: .deliver)
            try container.encodeIfPresent(channel, forKey: .channel)
            try container.encodeIfPresent(to, forKey: .to)
            try container.encodeIfPresent(bestEffortDeliver, forKey: .bestEffortDeliver)
        }
    }
}

struct CronJobState: Codable, Equatable {
    var nextRunAtMs: Int?
    var runningAtMs: Int?
    var lastRunAtMs: Int?
    var lastStatus: String?
    var lastError: String?
    var lastDurationMs: Int?
}

struct CronJob: Identifiable, Codable, Equatable {
    let id: String
    let agentId: String?
    var name: String
    var description: String?
    var enabled: Bool
    var deleteAfterRun: Bool?
    let createdAtMs: Int
    let updatedAtMs: Int
    let schedule: CronSchedule
    let sessionTarget: CronSessionTarget
    let wakeMode: CronWakeMode
    let payload: CronPayload
    let delivery: CronDelivery?
    let state: CronJobState

    var displayName: String {
        let trimmed = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled job" : trimmed
    }

    var nextRunDate: Date? {
        guard let ms = self.state.nextRunAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    var lastRunDate: Date? {
        guard let ms = self.state.lastRunAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }
}

extension CronJob {
    private enum EncodingKeys: String, CodingKey {
        case id, agentId, name, description, enabled, deleteAfterRun, createdAtMs, updatedAtMs
        case schedule, sessionTarget, wakeMode, payload, delivery, state
    }

    private enum DecodingKeys: String, CodingKey {
        case id, agentId, name, description, enabled, deleteAfterRun, createdAtMs, updatedAtMs
        case schedule, sessionTarget, wakeMode, postRun, payload, delivery, state
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: EncodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encodeIfPresent(self.agentId, forKey: .agentId)
        try container.encode(self.name, forKey: .name)
        try container.encodeIfPresent(self.description, forKey: .description)
        try container.encode(self.enabled, forKey: .enabled)
        try container.encodeIfPresent(self.deleteAfterRun, forKey: .deleteAfterRun)
        try container.encode(self.createdAtMs, forKey: .createdAtMs)
        try container.encode(self.updatedAtMs, forKey: .updatedAtMs)
        try container.encode(self.schedule, forKey: .schedule)
        try container.encode(self.sessionTarget, forKey: .sessionTarget)
        try container.encode(self.wakeMode, forKey: .wakeMode)
        try container.encode(self.payload, forKey: .payload)
        try container.encodeIfPresent(self.delivery, forKey: .delivery)
        try container.encode(self.state, forKey: .state)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DecodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.agentId = try container.decodeIfPresent(String.self, forKey: .agentId)
        self.name = try container.decode(String.self, forKey: .name)
        self.description = try container.decodeIfPresent(String.self, forKey: .description)
        self.enabled = try container.decode(Bool.self, forKey: .enabled)
        self.deleteAfterRun = try container.decodeIfPresent(Bool.self, forKey: .deleteAfterRun)
        self.createdAtMs = try container.decode(Int.self, forKey: .createdAtMs)
        self.updatedAtMs = try container.decode(Int.self, forKey: .updatedAtMs)
        self.schedule = try container.decode(CronSchedule.self, forKey: .schedule)
        self.sessionTarget = try container.decode(CronSessionTarget.self, forKey: .sessionTarget)
        if let wakeMode = try container.decodeIfPresent(CronWakeMode.self, forKey: .wakeMode) {
            self.wakeMode = wakeMode
        } else if let postRunRaw = try container.decodeIfPresent(String.self, forKey: .postRun) {
            self.wakeMode = postRunRaw == "trigger-heartbeat" ? .nextHeartbeat : .unknown(postRunRaw)
        } else {
            self.wakeMode = .now
        }
        self.payload = try container.decode(CronPayload.self, forKey: .payload)
        self.delivery = try container.decodeIfPresent(CronDelivery.self, forKey: .delivery)
        self.state = try container.decode(CronJobState.self, forKey: .state)
    }
}

struct CronEvent: Codable, Sendable {
    let jobId: String
    let action: String
    let runAtMs: Int?
    let durationMs: Int?
    let status: String?
    let error: String?
    let summary: String?
    let nextRunAtMs: Int?
}

struct CronRunLogEntry: Codable, Identifiable, Sendable {
    var id: String {
        "\(self.jobId)-\(self.ts)"
    }

    let ts: Int
    let jobId: String
    let action: String
    let status: String?
    let error: String?
    let summary: String?
    let runAtMs: Int?
    let durationMs: Int?
    let nextRunAtMs: Int?

    var date: Date {
        Date(timeIntervalSince1970: TimeInterval(self.ts) / 1000)
    }

    var runDate: Date? {
        guard let runAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(runAtMs) / 1000)
    }
}

struct CronListResponse: Codable {
    let jobs: [CronJob]
}

struct CronRunsResponse: Codable {
    let entries: [CronRunLogEntry]
}
