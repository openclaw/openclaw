import Foundation

enum ExecInlineCommandParser {
    struct Match {
        let tokenIndex: Int
        let inlineCommand: String?
        let valueTokenOffset: Int

        init(tokenIndex: Int, inlineCommand: String?, valueTokenOffset: Int = 1) {
            self.tokenIndex = tokenIndex
            self.inlineCommand = inlineCommand
            self.valueTokenOffset = valueTokenOffset
        }
    }

    private struct CombinedCommandFlag {
        let attachedCommand: String?
        let separateValueCount: Int
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
        self.hasPosixStartupBeforeInlineCommand(argv, flags: flags) {
            $0 == "--interactive" || self.isPosixShortOption($0, containing: "i")
        }
    }

    static func hasPosixLoginStartupBeforeInlineCommand(
        _ argv: [String],
        flags: Set<String>) -> Bool
    {
        self.hasPosixStartupBeforeInlineCommand(argv, flags: flags) {
            $0 == "--login" || self.isPosixShortOption($0, containing: "l")
        }
    }

    private static func hasPosixStartupBeforeInlineCommand(
        _ argv: [String],
        flags: Set<String>,
        matchesStartupOption: (String) -> Bool) -> Bool
    {
        var sawStartupOption = false
        let match = self.findMatch(argv, flags: flags, allowCombinedC: true) { token in
            if matchesStartupOption(token) {
                sawStartupOption = true
            }
        }
        return match != nil && sawStartupOption
    }

    static func hasFishInitCommandOption(_ argv: [String]) -> Bool {
        self.hasFishOption(argv) {
            $0.hasPrefix("-C") || $0 == "--init-command" || $0.hasPrefix("--init-command=")
        }
    }

    static func hasFishAttachedCommandOption(_ argv: [String]) -> Bool {
        self.hasFishOption(argv) { $0.hasPrefix("-c") && $0 != "-c" }
    }

    private static func hasFishOption(_ argv: [String], matching matches: (String) -> Bool) -> Bool {
        for argument in argv.dropFirst() {
            let token = argument.trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty { continue }
            if token == "--" { return false }
            if matches(token) { return true }
            if !token.hasPrefix("-"), !token.hasPrefix("+") { return false }
        }
        return false
    }

    static func findMatch(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool,
        visitOption: (String) -> Void = { _ in }) -> Match?
    {
        var idx = 1
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" { break }
            visitOption(token)
            let comparableToken = allowCombinedC ? token : token.lowercased()
            if flags.contains(comparableToken) {
                return Match(tokenIndex: idx, inlineCommand: nil)
            }
            if allowCombinedC, let combined = self.parseCombinedCommandFlag(token) {
                if let attachedCommand = combined.attachedCommand {
                    return Match(tokenIndex: idx, inlineCommand: attachedCommand, valueTokenOffset: 0)
                }
                return Match(
                    tokenIndex: idx,
                    inlineCommand: nil,
                    valueTokenOffset: 1 + combined.separateValueCount)
            }
            if allowCombinedC, !token.hasPrefix("-"), !token.hasPrefix("+") {
                break
            }
            let combinedValueCount = allowCombinedC ? self.combinedSeparateValueOptionCount(token) : 0
            if combinedValueCount > 0 {
                idx += 1 + combinedValueCount
                continue
            }
            if allowCombinedC, self.posixShellOptionsWithSeparateValues.contains(token) {
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
        let nextIndex = match.tokenIndex + match.valueTokenOffset
        let payload = nextIndex < argv.count
            ? argv[nextIndex]
            : ""
        return payload.isEmpty ? nil : payload
    }

    private static func parseCombinedCommandFlag(_ token: String) -> CombinedCommandFlag? {
        guard let optionChars = self.posixShortOptions(token),
              let commandFlagIndex = optionChars.firstIndex(of: "c")
        else {
            return nil
        }
        let suffix = String(optionChars.dropFirst(commandFlagIndex + 1))
        if !suffix.isEmpty,
           suffix.range(of: #"[^A-Za-z]"#, options: .regularExpression) != nil
        {
            return CombinedCommandFlag(attachedCommand: suffix, separateValueCount: 0)
        }
        let separateValueCount = optionChars.reduce(0) { count, char in
            count + ((char == "o" || char == "O") ? 1 : 0)
        }
        return CombinedCommandFlag(attachedCommand: nil, separateValueCount: separateValueCount)
    }

    private static func combinedSeparateValueOptionCount(_ token: String) -> Int {
        self.posixShortOptions(token, allowPlus: true)?.reduce(0) { count, char in
            count + ((char == "o" || char == "O") ? 1 : 0)
        } ?? 0
    }

    private static func isPosixShortOption(_ token: String, containing option: Character) -> Bool {
        self.posixShortOptions(token)?.contains(option) == true
    }

    private static func posixShortOptions(_ token: String, allowPlus: Bool = false) -> [Character]? {
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-" || (allowPlus && chars[0] == "+"),
              !chars.dropFirst().contains("-") else { return nil }
        return Array(chars.dropFirst())
    }
}
