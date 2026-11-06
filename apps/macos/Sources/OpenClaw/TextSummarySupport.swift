import Foundation

enum TextSummarySupport {
    static func summarizeLastLine(_ text: String, maxLength: Int = 200) -> String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        // Node fatal errors end with a bare "Node.js vX.Y.Z" banner. Surfacing
        // that line hides the actual failure ("Error: Cannot find module …"),
        // so drop the banner and prefer the last real error line above it.
        var candidates = lines[...]
        while let last = candidates.last, Self.isNodeVersionBanner(last) {
            candidates = candidates.dropLast()
        }
        let droppedNodeBanner = candidates.count != lines.count
        let hasCliFooter = candidates.last.map(self.isCliRecoveryFooter) ?? false
        if hasCliFooter {
            while let last = candidates.last, Self.isCliRecoveryFooter(last) {
                candidates = candidates.dropLast()
            }
            if candidates.count > 1, candidates.last == "[openclaw] The CLI command failed." {
                candidates = candidates.dropLast()
            }
        }
        var chosen = candidates.last ?? lines[lines.count - 1]
        // Root CLI recovery hints follow the diagnostic; debug output also adds a stack.
        if hasCliFooter, let reason = candidates.suffix(40).last(where: { $0.hasPrefix("[openclaw] Reason:") }) {
            chosen = reason
        } else if droppedNodeBanner, let errorLine = candidates.suffix(40).last(where: self.isErrorLine) {
            chosen = errorLine
        }
        let normalized = chosen.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if normalized.count > maxLength {
            return String(normalized.prefix(maxLength - 1)) + "…"
        }
        return normalized
    }

    private static func isCliRecoveryFooter(_ line: String) -> Bool {
        line.hasPrefix("[openclaw] For help, run `") ||
            line.hasPrefix("[openclaw] For details, open Settings → Logs in the Control UI or run `") ||
            line.hasPrefix("[openclaw] Try: ") || line.hasPrefix("[openclaw] Help: ")
    }

    private static func isNodeVersionBanner(_ line: String) -> Bool {
        line.range(of: #"^Node\.js v\d"#, options: .regularExpression) != nil
    }

    private static func isErrorLine(_ line: String) -> Bool {
        line.range(of: #"^\w*Error(\b|:)"#, options: .regularExpression) != nil
    }
}
