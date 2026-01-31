import Foundation

public enum OpenClawContactsCommand: String, Codable, Sendable {
    case search = "contacts.search"
}

public struct OpenClawContactsSearchParams: Codable, Sendable, Equatable {
    public var query: String?
    public var limit: Int?

    public init(query: String? = nil, limit: Int? = nil) {
        self.query = query
        self.limit = limit
    }
}

public struct OpenClawContactPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var displayName: String
    public var givenName: String
    public var familyName: String
    public var organizationName: String
    public var phoneNumbers: [String]
    public var emails: [String]

    public init(
        identifier: String,
        displayName: String,
        givenName: String,
        familyName: String,
        organizationName: String,
        phoneNumbers: [String],
        emails: [String])
    {
        self.identifier = identifier
        self.displayName = displayName
        self.givenName = givenName
        self.familyName = familyName
        self.organizationName = organizationName
        self.phoneNumbers = phoneNumbers
        self.emails = emails
    }
}

public struct OpenClawContactsSearchPayload: Codable, Sendable, Equatable {
    public var contacts: [OpenClawContactPayload]

    public init(contacts: [OpenClawContactPayload]) {
        self.contacts = contacts
    }
}
