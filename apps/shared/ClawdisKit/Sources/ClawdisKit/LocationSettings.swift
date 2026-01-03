import Foundation

public enum ClawdisLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
