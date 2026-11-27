import Foundation

/// OpenClaw's internal runtime context never reaches the reader. Mirrors the Control UI, which strips it from
/// every message before display (`stripInternalRuntimeContext` in src/agents/internal-runtime-context.ts, used by
/// ui/src/lib/chat/message-extract.ts). A subagent's first message, for one, carries its task inside these blocks.
enum ChatInternalContext {
    static let begin = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"
    static let end = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"
    static let header = "OpenClaw runtime context:"
    static let footer = "End OpenClaw runtime context."

    /// Drops protected blocks (nested, each delimiter alone on its line), current header/footer blocks and a
    /// stray end delimiter. An unterminated block hides the rest of the text, as on the web.
    static func strip(_ text: String) -> String {
        guard text.contains("OPENCLAW_INTERNAL_CONTEXT") || text.contains(self.header) else { return text }
        var kept: [Substring] = []
        var depth = 0
        var inCurrent = false
        for line in text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            let token = self.token(line)
            if inCurrent {
                if token == self.footer { inCurrent = false }
                continue
            }
            if token == self.begin {
                depth += 1
                continue
            }
            if token == self.end {
                depth = max(0, depth - 1)
                continue
            }
            if depth > 0 { continue }
            if token == self.header {
                inCurrent = true
                continue
            }
            kept.append(line)
        }
        return kept.joined(separator: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The line's delimiter, if it is one. A delivery envelope ("[Wed 2026-11-25 19:06 PST] ") may sit in
    /// front of the opening delimiter on the same line.
    private static func token(_ line: Substring) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("["), trimmed.hasSuffix(self.begin),
           let close = trimmed.firstIndex(of: "]"),
           trimmed[trimmed.index(after: close)...].trimmingCharacters(in: .whitespaces) == self.begin
        {
            return self.begin
        }
        return [self.begin, self.end, self.header, self.footer].contains(trimmed) ? trimmed : nil
    }
}
