import Foundation

public struct MullusiDateRangeLimitParams: Codable, Sendable, Equatable {
    public var startISO: String?
    public var endISO: String?
    public var limit: Int?

    public init(startISO: String? = nil, endISO: String? = nil, limit: Int? = nil) {
        self.startISO = startISO
        self.endISO = endISO
        self.limit = limit
    }
}
