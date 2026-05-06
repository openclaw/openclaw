import Foundation

enum ExecInlineCommandParser {
    struct Match {
        let tokenIndex: Int
        let inlineCommand: String?
    }

    static func findMatch(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> Match?
    {
        var idx = 1
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            let lower = token.lowercased()
            if lower == "--" {
                break
            }
            if flags.contains(lower) {
                return Match(tokenIndex: idx, inlineCommand: nil)
            }
            if allowCombinedC, let inlineOffset = self.combinedCommandInlineOffset(token) {
                let inline = String(token.dropFirst(inlineOffset))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return Match(
                    tokenIndex: idx,
                    inlineCommand: inline.isEmpty ? nil : inline)
            }
            idx += 1
        }
        return nil
    }

    static func extractInlineCommand(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> String?
    {
        guard let match = self.findMatch(argv, flags: flags, allowCombinedC: allowCombinedC) else {
            return nil
        }
        if let inlineCommand = match.inlineCommand {
            return inlineCommand
        }
        let nextIndex = match.tokenIndex + 1
        let payload = nextIndex < argv.count
            ? argv[nextIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        return payload.isEmpty ? nil : payload
    }

    private static func combinedCommandInlineOffset(_ token: String) -> Int? {
        let chars = Array(token.lowercased())
        guard chars.count >= 2, chars[0] == "-", chars[1] != "-" else {
            return nil
        }
        if chars.dropFirst().contains("-") {
            return nil
        }
        guard let commandIndex = chars.firstIndex(of: "c"), commandIndex > 0 else {
            return nil
        }
        return commandIndex + 1
    }
}
