import Foundation

public enum SmartAgentNeoRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum SmartAgentNeoReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct SmartAgentNeoRemindersListParams: Codable, Sendable, Equatable {
    public var status: SmartAgentNeoReminderStatusFilter?
    public var limit: Int?

    public init(status: SmartAgentNeoReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct SmartAgentNeoRemindersAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var dueISO: String?
    public var notes: String?
    public var listId: String?
    public var listName: String?

    public init(
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        listId: String? = nil,
        listName: String? = nil)
    {
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.listId = listId
        self.listName = listName
    }
}

public struct SmartAgentNeoReminderPayload: Codable, Sendable, Equatable {
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

public struct SmartAgentNeoRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [SmartAgentNeoReminderPayload]

    public init(reminders: [SmartAgentNeoReminderPayload]) {
        self.reminders = reminders
    }
}

public struct SmartAgentNeoRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: SmartAgentNeoReminderPayload

    public init(reminder: SmartAgentNeoReminderPayload) {
        self.reminder = reminder
    }
}
