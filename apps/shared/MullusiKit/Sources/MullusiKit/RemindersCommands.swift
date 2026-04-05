import Foundation

public enum MullusiRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum MullusiReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct MullusiRemindersListParams: Codable, Sendable, Equatable {
    public var status: MullusiReminderStatusFilter?
    public var limit: Int?

    public init(status: MullusiReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct MullusiRemindersAddParams: Codable, Sendable, Equatable {
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

public struct MullusiReminderPayload: Codable, Sendable, Equatable {
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

public struct MullusiRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [MullusiReminderPayload]

    public init(reminders: [MullusiReminderPayload]) {
        self.reminders = reminders
    }
}

public struct MullusiRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: MullusiReminderPayload

    public init(reminder: MullusiReminderPayload) {
        self.reminder = reminder
    }
}
