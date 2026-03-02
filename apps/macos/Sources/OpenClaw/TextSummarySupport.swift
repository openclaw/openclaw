import Foundation

enum TextSummarySupport {
    static func summarizeLastLine(_ text: String, maxLength: Int = 200) -> String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let last = lines.last else { return nil }
        let normalized = last.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if normalized.count > maxLength {
            return String(normalized.prefix(maxLength - 1)) + "…"
        }
        return normalized
    }
}
