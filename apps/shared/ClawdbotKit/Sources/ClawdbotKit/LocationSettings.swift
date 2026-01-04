import Foundation

public enum ClawdbotLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
