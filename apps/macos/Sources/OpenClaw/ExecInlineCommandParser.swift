import Foundation

enum ExecInlineCommandParser {
    struct Match {
        let tokenIndex: Int
        let inlineCommand: String?
    }

    private static let posixShellOptionsWithSeparateValues = Set([
        "--init-file",
        "--rcfile",
        "-O",
        "-o",
        "+O",
        "+o",
    ])

    static func hasPosixInteractiveStartupBeforeInlineCommand(
        _ argv: [String],
        flags: Set<String>) -> Bool
    {
        var idx = 1
        var sawStartupOption = false
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                return false
            }
            if self.isPosixInteractiveStartupOption(token) {
                sawStartupOption = true
            }
            if flags.contains(token) || self.isCombinedCommandFlag(token) {
                return sawStartupOption
            }
            if !token.hasPrefix("-"), !token.hasPrefix("+") {
                return false
            }
            if self.consumesSeparateValue(token) {
                idx += 2
                continue
            }
            idx += 1
        }
        return false
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
            if token == "--" {
                break
            }
            let comparableToken = allowCombinedC ? token : token.lowercased()
            if flags.contains(comparableToken) {
                return Match(tokenIndex: idx, inlineCommand: nil)
            }
            if allowCombinedC, self.isCombinedCommandFlag(token) {
                return Match(tokenIndex: idx, inlineCommand: nil)
            }
            if allowCombinedC, !token.hasPrefix("-"), !token.hasPrefix("+") {
                break
            }
            if allowCombinedC, self.consumesSeparateValue(token) {
                idx += 2
                continue
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

    private static func isCombinedCommandFlag(_ token: String) -> Bool {
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-", chars[1] != "-" else {
            return false
        }
        if chars.dropFirst().contains("-") {
            return false
        }
        return chars.dropFirst().contains("c")
    }

    private static func consumesSeparateValue(_ token: String) -> Bool {
        return self.posixShellOptionsWithSeparateValues.contains(token)
    }

    private static func isPosixInteractiveStartupOption(_ token: String) -> Bool {
        if token == "--init-file" || token == "--rcfile" {
            return true
        }
        if token.hasPrefix("--init-file=") || token.hasPrefix("--rcfile=") {
            return true
        }
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-", chars[1] != "-" else {
            return false
        }
        if chars.dropFirst().contains("-") {
            return false
        }
        return chars.dropFirst().contains("i")
    }
}
