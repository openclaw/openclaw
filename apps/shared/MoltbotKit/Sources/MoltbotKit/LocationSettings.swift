import Foundation

public enum DNALocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
