import Foundation

enum SessionKey {
    static func normalizeMainKey(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "main" : trimmed
    }

    static func isCanonicalMainSessionKey(_ value: String?) -> Bool {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.caseInsensitiveCompare("main") == .orderedSame
    }
}
