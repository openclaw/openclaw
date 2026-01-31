import Foundation

public enum OpenClawRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
}

public enum OpenClawReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct OpenClawRemindersListParams: Codable, Sendable, Equatable {
    public var status: OpenClawReminderStatusFilter?
    public var limit: Int?

    public init(status: OpenClawReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct OpenClawReminderPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var dueISO: String?
    public var completed: Bool
    public var listName: String?

    public init(
        identifier: String,
        title: String,
        dueISO: String? = nil,
        completed: Bool,
        listName: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.dueISO = dueISO
        self.completed = completed
        self.listName = listName
    }
}

public struct OpenClawRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [OpenClawReminderPayload]

    public init(reminders: [OpenClawReminderPayload]) {
        self.reminders = reminders
    }
}
