import Foundation

public enum SmartAgentNeoLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
