import Foundation

struct ExecApprovalEvaluation {
    let command: [String]
    let displayCommand: String
    let agentId: String?
    let security: ExecSecurity
    let ask: ExecAsk
    let env: [String: String]
    let resolution: ExecCommandResolution?
    let allowlistResolutions: [ExecCommandResolution]
    let allowAlwaysPatterns: [String]
    let allowlistMatches: [ExecAllowlistEntry]
    let allowlistSatisfied: Bool
    let allowlistMatch: ExecAllowlistEntry?
    let denylistDenied: Bool
    let skillAllow: Bool
}

enum ExecDenylistEvaluator {
    private enum CandidateKind: Hashable {
        case shell
        case argument
        case executable
        case payload
        case env
    }

    private struct Candidate: Hashable {
        var value: String
        var kind: CandidateKind
    }

    private static let maxRules = 256
    private static let maxPatternLength = 8 * 1024
    private static let maxInspectedCharacters = 256 * 1024
    private static let allowedFlags = Set(["i", "m", "u"])
    private static let defaultShellNetworkFetchId = "default-shell-network-fetch"
    private static let defaultShellNetworkFetchInvocationRegex = try? NSRegularExpression(
        pattern: #"(?:^|[;&|()<>])\s*(?:[^\s;&|()<>]*[\\/])?(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
        options: [.caseInsensitive])
    private static let defaultShellNetworkFetchLeadingExpansionRegex = try? NSRegularExpression(
        pattern: #"(?:^|[;&|()<>])\s*(?:(?:\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!)\s*)+(?:[^\s;&|()<>]*[\\/])?(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
        options: [.caseInsensitive])
    private static let shellCommandSeparators = Set<Character>([";", "&", "|", "(", ")", "<", ">"])
    private static let sudoNonExecutingOptions = Set([
        "-K",
        "-l",
        "-V",
        "-v",
        "-e",
        "--edit",
        "--help",
        "--list",
        "--remove-timestamp",
        "--validate",
        "--version",
    ])
    private static let sudoOptionsWithValue = Set([
        "-C",
        "-D",
        "-g",
        "-h",
        "-p",
        "-R",
        "-T",
        "-U",
        "-u",
        "--chdir",
        "--chroot",
        "--close-from",
        "--command-timeout",
        "--group",
        "--host",
        "--other-user",
        "--prompt",
        "--role",
        "--type",
        "--user",
    ])

    static func denied(
        command: [String],
        displayCommand: String,
        env: [String: String],
        denylist: [ExecDenylistEntry]) -> Bool
    {
        guard !denylist.isEmpty else { return false }
        guard denylist.count <= self.maxRules else { return true }
        let candidates = self.candidates(command: command, displayCommand: displayCommand, env: env)
        let inspectedCharacters = candidates.reduce(0) { total, candidate in
            min(self.maxInspectedCharacters + 1, total + candidate.value.count)
        }
        guard inspectedCharacters <= self.maxInspectedCharacters else { return true }

        for entry in denylist {
            let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pattern.isEmpty else { return true }
            guard pattern.count <= self.maxPatternLength else { return true }
            guard let options = self.regexOptions(flags: entry.flags) else { return true }
            guard !self.hasUnsafeRepetition(pattern) else { return true }
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return true }
            for candidate in candidates {
                if self.isDefaultShellNetworkFetchEntry(entry),
                   self.isShellNetworkFetchInvocation(candidate)
                {
                    return true
                }
                guard !self.isDefaultShellNetworkFetchEntry(entry) else { continue }
                let range = NSRange(candidate.value.startIndex..<candidate.value.endIndex, in: candidate.value)
                if regex.firstMatch(in: candidate.value, options: [], range: range) != nil {
                    return true
                }
            }
        }
        return false
    }

    private static func isDefaultShellNetworkFetchEntry(_ entry: ExecDenylistEntry) -> Bool {
        entry.id == self.defaultShellNetworkFetchId &&
            entry.pattern == [
                #"(?:^|[\s;&|()<>])(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
                #"[\\/](?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
            ].joined(separator: "|") &&
            entry.flags?.trimmingCharacters(in: .whitespacesAndNewlines) == "i"
    }

    private static func regexOptions(flags: String?) -> NSRegularExpression.Options? {
        let raw = flags?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var options: NSRegularExpression.Options = []
        var seen = Set<String>()
        for char in raw {
            let flag = String(char)
            guard self.allowedFlags.contains(flag) else { return nil }
            guard seen.insert(flag).inserted else { continue }
            switch flag {
            case "i":
                options.insert(.caseInsensitive)
            case "m":
                options.insert(.anchorsMatchLines)
            case "u":
                continue
            default:
                return nil
            }
        }
        return options
    }

    private struct RegexGroupFrame {
        var containsQuantifier = false
        var hasAlternation = false
        var branchLength = 0
        var altMinLength: Int?
        var altMaxLength: Int?
    }

    private static func hasUnsafeRepetition(_ pattern: String) -> Bool {
        let chars = Array(pattern)
        var stack: [RegexGroupFrame] = []
        var escaped = false
        var inCharacterClass = false

        func recordAlternative(_ frame: inout RegexGroupFrame) {
            frame.altMinLength = min(frame.altMinLength ?? frame.branchLength, frame.branchLength)
            frame.altMaxLength = max(frame.altMaxLength ?? frame.branchLength, frame.branchLength)
        }

        for (index, char) in chars.enumerated() {
            if escaped {
                if !stack.isEmpty {
                    stack[stack.count - 1].branchLength += 1
                }
                escaped = false
                continue
            }
            if char == "\\" {
                escaped = true
                continue
            }
            if char == "[" {
                inCharacterClass = true
                if !stack.isEmpty {
                    stack[stack.count - 1].branchLength += 1
                }
                continue
            }
            if char == "]" {
                inCharacterClass = false
                continue
            }
            if inCharacterClass {
                continue
            }

            if char == "(" {
                stack.append(RegexGroupFrame())
                continue
            }
            if char == ")" {
                guard var group = stack.popLast() else { continue }
                if group.hasAlternation {
                    recordAlternative(&group)
                }
                let quantifiedGroup = self.isRegexQuantifierStart(chars, at: index + 1)
                let unboundedQuantifiedGroup = self.isUnboundedRegexQuantifier(chars, at: index + 1)
                if group.containsQuantifier, quantifiedGroup {
                    return true
                }
                if group.hasAlternation,
                   group.altMinLength != nil,
                   group.altMaxLength != nil,
                   group.altMinLength != group.altMaxLength,
                   unboundedQuantifiedGroup
                {
                    return true
                }
                if !stack.isEmpty {
                    stack[stack.count - 1].branchLength += group.altMinLength ?? group.branchLength
                    if group.containsQuantifier || quantifiedGroup {
                        stack[stack.count - 1].containsQuantifier = true
                    }
                }
                continue
            }
            if char == "|", !stack.isEmpty {
                stack[stack.count - 1].hasAlternation = true
                recordAlternative(&stack[stack.count - 1])
                stack[stack.count - 1].branchLength = 0
                continue
            }
            if self.isGroupSyntaxMarker(chars, at: index) {
                continue
            }
            if self.isRegexQuantifierStart(chars, at: index), !stack.isEmpty {
                stack[stack.count - 1].containsQuantifier = true
                continue
            }
            if !stack.isEmpty {
                stack[stack.count - 1].branchLength += 1
            }
        }
        return false
    }

    private static func isRegexQuantifierStart(_ chars: [Character], at index: Int) -> Bool {
        guard index < chars.count else { return false }
        let char = chars[index]
        return char == "*" || char == "+" || char == "?" || char == "{"
    }

    private static func isGroupSyntaxMarker(_ chars: [Character], at index: Int) -> Bool {
        index > 0 && chars[index] == "?" && chars[index - 1] == "("
    }

    private static func isUnboundedRegexQuantifier(_ chars: [Character], at index: Int) -> Bool {
        guard index < chars.count else { return false }
        let char = chars[index]
        if char == "*" || char == "+" {
            return true
        }
        guard char == "{" else { return false }

        var cursor = index + 1
        var sawDigit = false
        while cursor < chars.count, chars[cursor].isNumber {
            sawDigit = true
            cursor += 1
        }
        guard sawDigit, cursor < chars.count, chars[cursor] == "," else {
            return false
        }
        cursor += 1
        var sawUpperBound = false
        while cursor < chars.count, chars[cursor].isNumber {
            sawUpperBound = true
            cursor += 1
        }
        return cursor < chars.count && chars[cursor] == "}" && !sawUpperBound
    }

    private static func candidates(
        command: [String],
        displayCommand: String,
        env: [String: String]) -> [Candidate]
    {
        var values: [Candidate] = []
        var expansionEnv = env
        self.push(&values, displayCommand, kind: .shell)
        self.push(&values, command.joined(separator: " "), kind: .shell)
        self.push(&values, command.first, kind: .executable)
        for arg in command {
            self.push(&values, arg, kind: .argument)
            self.push(&values, self.inlineEnvAssignmentValue(arg), kind: .argument)
            if let assignment = self.inlineEnvAssignment(arg) {
                expansionEnv[assignment.name] = assignment.value
            }
        }
        for candidate in self.shellPayloadCandidates(command: command) {
            self.push(&values, candidate.value, kind: candidate.kind)
        }
        for line in displayCommand.components(separatedBy: .newlines) {
            self.push(&values, line, kind: .shell)
        }
        for reference in self.envReferences(in: displayCommand) {
            if let value = self.resolveEnv(env, reference: reference) {
                self.push(&values, value, kind: .env)
            }
        }
        for candidate in values {
            self.push(
                &values,
                self.expandEnvReferences(in: candidate.value, env: expansionEnv),
                kind: candidate.kind)
        }
        return Array(Set(values))
    }

    private static func push(_ values: inout [Candidate], _ value: String?, kind: CandidateKind) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            values.append(Candidate(value: trimmed, kind: kind))
        }
    }

    private static func inlineEnvAssignmentValue(_ token: String) -> String? {
        self.inlineEnvAssignment(token)?.value
    }

    private static func inlineEnvAssignment(_ token: String) -> (name: String, value: String)? {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let equals = trimmed.firstIndex(of: "="), equals > trimmed.startIndex else { return nil }
        let name = trimmed[..<equals]
        guard let first = name.unicodeScalars.first, self.isPortableEnvHead(first) else { return nil }
        for scalar in name.unicodeScalars.dropFirst() {
            guard self.isPortableEnvTail(scalar) else { return nil }
        }
        let valueStart = trimmed.index(after: equals)
        return (String(name), String(trimmed[valueStart...]))
    }

    private static func isPortableEnvHead(_ scalar: UnicodeScalar) -> Bool {
        let value = scalar.value
        return value == 95 || (65...90).contains(value) || (97...122).contains(value)
    }

    private static func isPortableEnvTail(_ scalar: UnicodeScalar) -> Bool {
        let value = scalar.value
        return self.isPortableEnvHead(scalar) || (48...57).contains(value)
    }

    private static func shellPayloadCandidates(command: [String]) -> [Candidate] {
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        guard shell.isWrapper, let payload = shell.command else { return [] }
        let words = self.splitShellWords(payload)
        return words.map { Candidate(value: $0, kind: .argument) } +
            [Candidate(value: words.joined(separator: " "), kind: .payload)]
    }

    static func splitShellWords(_ value: String) -> [String] {
        var words: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false

        for char in value {
            if escaped {
                current.append(char)
                escaped = false
                continue
            }
            if char == "\\" {
                escaped = true
                continue
            }
            if char == "'", !inDouble {
                inSingle.toggle()
                continue
            }
            if char == "\"", !inSingle {
                inDouble.toggle()
                continue
            }
            if char.isWhitespace, !inSingle, !inDouble {
                self.pushWord(&words, current)
                current = ""
                continue
            }
            current.append(char)
        }
        if escaped {
            current.append("\\")
        }
        self.pushWord(&words, current)
        return words
    }

    private static func pushWord(_ values: inout [String], _ value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            values.append(trimmed)
        }
    }

    private static func normalizedExecutableName(_ value: String?) -> String {
        guard let value else { return "" }
        let last = value.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? value
        let lowered = last.lowercased()
        return lowered.hasSuffix(".exe") ? String(lowered.dropLast(4)) : lowered
    }

    private static func isShellNetworkFetchExecutable(_ value: String?) -> Bool {
        let command = self.normalizedExecutableName(value)
        return command == "curl" || command == "wget"
    }

    private static func isShellNetworkFetchArgv(_ argv: [String], depth: Int = 0) -> Bool {
        guard depth <= 8, !argv.isEmpty else { return false }
        if self.isShellNetworkFetchExecutable(argv.first) {
            return true
        }
        guard let carried = self.carriedCommandArgv(argv) else { return false }
        return self.isShellNetworkFetchArgv(carried, depth: depth + 1)
    }

    private static func carriedCommandArgv(_ argv: [String]) -> [String]? {
        let executable = self.normalizedExecutableName(argv.first)
        switch executable {
        case "env":
            return self.envCarriedCommandArgv(argv)
        case "sudo", "doas":
            return self.sudoLikeCarriedCommandArgv(argv, executable: executable)
        case "command", "builtin", "exec":
            return self.commandBuiltinCarriedCommandArgv(argv)
        default:
            return nil
        }
    }

    private static func envCarriedCommandArgv(_ argv: [String]) -> [String]? {
        var index = 1
        while index < argv.count {
            let token = argv[index]
            if self.inlineEnvAssignment(token) != nil {
                index += 1
                continue
            }
            if token == "--" || token == "-" {
                index += 1
                break
            }
            if token.hasPrefix("-") {
                let option = token.components(separatedBy: "=").first ?? token
                if let clusteredSplit = self.envClusteredSplitPayload(token) {
                    let payload = clusteredSplit.payload ??
                        (index + 1 < argv.count ? argv[index + 1] : "")
                    let trailingIndex = clusteredSplit.consumesNext ? index + 2 : index + 1
                    let split = self.splitShellWords(payload)
                    if split.isEmpty { return nil }
                    return split + Array(argv.suffix(from: min(trailingIndex, argv.count)))
                }
                if ["-S", "-s", "--split-string"].contains(option) || option.hasPrefix("--split-string=") {
                    let payload = token.contains("=")
                        ? token.components(separatedBy: "=").dropFirst().joined(separator: "=")
                        : (index + 1 < argv.count ? argv[index + 1] : "")
                    let trailingIndex = token.contains("=") ? index + 1 : index + 2
                    let split = self.splitShellWords(payload)
                    if split.isEmpty { return nil }
                    return split + Array(argv.suffix(from: min(trailingIndex, argv.count)))
                }
                if token.hasPrefix("-S") || token.hasPrefix("-s"), token.count > 2 {
                    let payload = String(token.dropFirst(2))
                    let split = self.splitShellWords(payload)
                    if split.isEmpty { return nil }
                    return split + Array(argv.suffix(from: min(index + 1, argv.count)))
                }
                if ["-i", "-0", "--ignore-environment", "--null"].contains(option) {
                    index += 1
                    continue
                }
                if [
                    "-C",
                    "-P",
                    "-u",
                    "--argv0",
                    "--block-signal",
                    "--chdir",
                    "--default-signal",
                    "--ignore-signal",
                    "--unset",
                ].contains(option) {
                    index += token.contains("=") ? 1 : 2
                    continue
                }
                return nil
            }
            break
        }
        return index < argv.count ? Array(argv[index...]) : nil
    }

    private static func envClusteredSplitPayload(_ token: String) -> (payload: String?, consumesNext: Bool)? {
        guard token.hasPrefix("-"), !token.hasPrefix("--") else { return nil }
        let chars = Array(token)
        guard chars.count > 2 else { return nil }
        for index in 1..<chars.count where chars[index] == "S" || chars[index] == "s" {
            guard chars[1..<index].allSatisfy({ $0 == "i" || $0 == "0" }) else { return nil }
            let suffixStart = index + 1
            let payload = suffixStart < chars.count ? String(chars[suffixStart...]) : nil
            return (payload, payload == nil)
        }
        return nil
    }

    private static func sudoLikeCarriedCommandArgv(_ argv: [String], executable: String) -> [String]? {
        var index = 1
        while index < argv.count {
            let token = argv[index]
            if token == "--" {
                index += 1
                break
            }
            if !token.hasPrefix("-") {
                break
            }
            let option = token.components(separatedBy: "=").first ?? token
            if executable == "sudo", self.sudoNonExecutingOptions.contains(option) {
                return nil
            }
            let consumesValue = executable == "sudo"
                ? self.sudoOptionsWithValue.contains(option)
                : ["-a", "-C", "-u"].contains(option)
            index += consumesValue && !token.contains("=") ? 2 : 1
        }
        while executable == "sudo", index < argv.count, self.inlineEnvAssignment(argv[index]) != nil {
            index += 1
        }
        return index < argv.count ? Array(argv[index...]) : nil
    }

    private static func commandBuiltinCarriedCommandArgv(_ argv: [String]) -> [String]? {
        var index = 1
        while index < argv.count {
            let token = argv[index]
            if token == "--" {
                index += 1
                break
            }
            if !token.hasPrefix("-") {
                break
            }
            let option = token.components(separatedBy: "=").first ?? token
            if ["-v", "-V"].contains(option) {
                return nil
            }
            if option == "-a" {
                index += token.contains("=") ? 1 : 2
                continue
            }
            if ["-p", "-c", "-l"].contains(option) {
                index += 1
                continue
            }
            return nil
        }
        return index < argv.count ? Array(argv[index...]) : nil
    }

    private static func isShellNetworkFetchInvocation(_ candidate: Candidate) -> Bool {
        switch candidate.kind {
        case .argument, .env:
            return false
        case .executable:
            return self.isShellNetworkFetchExecutable(candidate.value)
        case .shell, .payload:
            if let regex = self.defaultShellNetworkFetchInvocationRegex {
                let range = NSRange(candidate.value.startIndex..<candidate.value.endIndex, in: candidate.value)
                if regex.firstMatch(in: candidate.value, options: [], range: range) != nil {
                    return true
                }
            }
            if let regex = self.defaultShellNetworkFetchLeadingExpansionRegex {
                let range = NSRange(candidate.value.startIndex..<candidate.value.endIndex, in: candidate.value)
                if regex.firstMatch(in: candidate.value, options: [], range: range) != nil {
                    return true
                }
            }
            if self.hasNetworkFetchCommandSubstitution(candidate.value) {
                return true
            }
            return self.isShellNetworkFetchArgv(self.splitShellWords(candidate.value))
        }
    }

    private static func shellCommandWords(_ value: String) -> [String] {
        let chars = Array(value)
        var words: [String] = []
        var index = 0
        var expectCommand = true
        while index < chars.count {
            if expectCommand {
                while index < chars.count, chars[index].isWhitespace {
                    index += 1
                }
                while index < chars.count, self.shellCommandSeparators.contains(chars[index]) {
                    index += 1
                    while index < chars.count, chars[index].isWhitespace {
                        index += 1
                    }
                }
                guard index < chars.count else { break }
                let result = self.readShellCommandWord(chars, start: index)
                if !result.word.isEmpty {
                    words.append(result.word)
                }
                index = result.end
                expectCommand = false
            } else {
                if self.shellCommandSeparators.contains(chars[index]) {
                    expectCommand = true
                }
                index += 1
            }
        }
        return words
    }

    private static func readShellCommandWord(
        _ chars: [Character],
        start: Int) -> (word: String, end: Int)
    {
        var word = ""
        var index = start
        var inSingle = false
        var inDouble = false
        while index < chars.count {
            let char = chars[index]
            if !inSingle, !inDouble, char.isWhitespace || self.shellCommandSeparators.contains(char) {
                break
            }
            if char == "\\", index + 1 < chars.count {
                word.append(char)
                word.append(chars[index + 1])
                index += 2
                continue
            }
            if char == "'", !inDouble {
                inSingle.toggle()
                word.append(char)
                index += 1
                continue
            }
            if char == "\"", !inSingle {
                inDouble.toggle()
                word.append(char)
                index += 1
                continue
            }
            if !inSingle, char == "$", index + 1 < chars.count, chars[index + 1] == "(" {
                var depth = 1
                word.append("$(")
                index += 2
                while index < chars.count, depth > 0 {
                    if chars[index] == "$", index + 1 < chars.count, chars[index + 1] == "(" {
                        depth += 1
                        word.append("$(")
                        index += 2
                        continue
                    }
                    if chars[index] == ")" {
                        depth -= 1
                    }
                    word.append(chars[index])
                    index += 1
                }
                continue
            }
            if !inSingle, char == "`" {
                word.append(char)
                index += 1
                while index < chars.count {
                    let nested = chars[index]
                    word.append(nested)
                    index += nested == "\\" && index + 1 < chars.count ? 2 : 1
                    if nested == "`" {
                        break
                    }
                }
                continue
            }
            word.append(char)
            index += 1
        }
        return (word, index)
    }

    private static func stripShellCommandSubstitutions(_ word: String) -> (substituted: Bool, literal: String) {
        let chars = Array(word)
        var literal = ""
        var index = 0
        var substituted = false
        while index < chars.count {
            let char = chars[index]
            if char == "$", index + 1 < chars.count, chars[index + 1] == "(" {
                substituted = true
                var depth = 1
                index += 2
                while index < chars.count, depth > 0 {
                    if chars[index] == "$", index + 1 < chars.count, chars[index + 1] == "(" {
                        depth += 1
                        index += 2
                        continue
                    }
                    if chars[index] == ")" {
                        depth -= 1
                    }
                    index += 1
                }
                continue
            }
            if char == "`" {
                substituted = true
                index += 1
                while index < chars.count {
                    let nested = chars[index]
                    index += nested == "\\" && index + 1 < chars.count ? 2 : 1
                    if nested == "`" {
                        break
                    }
                }
                continue
            }
            if char == "\\", index + 1 < chars.count {
                literal.append(chars[index + 1])
                index += 2
                continue
            }
            literal.append(char)
            index += 1
        }
        return (substituted, literal)
    }

    private static func isSubsequence(_ value: String, of target: String) -> Bool {
        var cursor = target.startIndex
        for char in value {
            guard let match = target[cursor...].firstIndex(of: char) else {
                return false
            }
            cursor = target.index(after: match)
        }
        return true
    }

    private static func hasNetworkFetchCommandSubstitution(_ value: String) -> Bool {
        for word in self.shellCommandWords(value) {
            let stripped = self.stripShellCommandSubstitutions(word)
            guard stripped.substituted else { continue }
            let command = self.normalizedExecutableName(stripped.literal)
            if command.count >= 2,
               self.isSubsequence(command, of: "curl") || self.isSubsequence(command, of: "wget")
            {
                return true
            }
        }
        return false
    }

    private struct EnvReference: Hashable {
        var name: String
        var caseInsensitive: Bool
    }

    private static func envReferences(in command: String) -> [EnvReference] {
        var references: [EnvReference] = []
        var seen = Set<EnvReference>()
        func append(_ name: String?, caseInsensitive: Bool) {
            guard let name, !name.isEmpty else { return }
            let reference = EnvReference(name: name, caseInsensitive: caseInsensitive)
            if seen.insert(reference).inserted {
                references.append(reference)
            }
        }

        for match in self.matches(
            #"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))"#,
            in: command)
        {
            append(match.first, caseInsensitive: false)
        }
        for match in self.matches(
            #"\$(?:env:([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})"#,
            in: command,
            options: [.caseInsensitive])
        {
            append(match.first, caseInsensitive: true)
        }
        for match in self.matches(
            #"%(?:([A-Za-z_][A-Za-z0-9_]*))%|!(?:([A-Za-z_][A-Za-z0-9_]*))!"#,
            in: command)
        {
            append(match.first, caseInsensitive: true)
        }
        return references
    }

    private static func matches(
        _ pattern: String,
        in value: String,
        options: NSRegularExpression.Options = []) -> [[String]]
    {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.matches(in: value, options: [], range: range).map { match in
            (1..<match.numberOfRanges).compactMap { index in
                let range = match.range(at: index)
                guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return nil }
                return String(value[swiftRange])
            }
        }
    }

    private static func expandEnvReferences(in value: String, env: [String: String]) -> String? {
        var expanded = value
        var changed = false
        func apply(_ pattern: String, caseInsensitive: Bool) {
            let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options)
            else {
                return
            }
            let matches = regex.matches(
                in: expanded,
                options: [],
                range: NSRange(expanded.startIndex..<expanded.endIndex, in: expanded))
            for match in matches.reversed() {
                let names = (1..<match.numberOfRanges).compactMap { index -> String? in
                    let range = match.range(at: index)
                    guard range.location != NSNotFound, let swiftRange = Range(range, in: expanded)
                    else {
                        return nil
                    }
                    return String(expanded[swiftRange])
                }
                guard let name = names.first,
                      let replacement = self.resolveEnv(
                          env,
                          reference: EnvReference(name: name, caseInsensitive: caseInsensitive)),
                      let fullRange = Range(match.range, in: expanded)
                else {
                    continue
                }
                expanded.replaceSubrange(fullRange, with: replacement)
                changed = true
            }
        }

        apply(
            #"\$(?:env:([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})"#,
            caseInsensitive: true)
        apply(
            #"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))"#,
            caseInsensitive: false)
        apply(
            #"%(?:([A-Za-z_][A-Za-z0-9_]*))%|!(?:([A-Za-z_][A-Za-z0-9_]*))!"#,
            caseInsensitive: true)
        return changed ? expanded : nil
    }

    private static func resolveEnv(_ env: [String: String], reference: EnvReference) -> String? {
        if let exact = env[reference.name] {
            return exact
        }
        guard reference.caseInsensitive else { return nil }
        let normalized = reference.name.lowercased()
        return env.first { key, _ in key.lowercased() == normalized }?.value
    }
}

enum ExecApprovalEvaluator {
    static func evaluate(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        envOverrides: [String: String]?,
        agentId: String?,
        requestedSecurity: ExecSecurity? = nil,
        requestedAsk: ExecAsk? = nil) async -> ExecApprovalEvaluation
    {
        let trimmedAgent = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAgentId = (trimmedAgent?.isEmpty == false) ? trimmedAgent : nil
        let approvals = ExecApprovalsStore.resolve(agentId: normalizedAgentId)
        let security = requestedSecurity.map { self.minSecurity(approvals.agent.security, $0) }
            ?? approvals.agent.security
        let ask = requestedAsk.map { self.maxAsk(approvals.agent.ask, $0) } ?? approvals.agent.ask
        let shellWrapper = ExecShellWrapperParser.extract(command: command, rawCommand: rawCommand).isWrapper
        let env = HostEnvSanitizer.sanitize(overrides: envOverrides, shellWrapper: shellWrapper)
        let displayCommand = ExecCommandFormatter.displayString(for: command, rawCommand: rawCommand)
        let allowlistRawCommand = ExecSystemRunCommandValidator.allowlistEvaluationRawCommand(
            command: command,
            rawCommand: rawCommand)
        let allowlistResolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: allowlistRawCommand,
            cwd: cwd,
            env: env)
        let allowAlwaysPatterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: command,
            cwd: cwd,
            env: env,
            rawCommand: allowlistRawCommand)
        let allowlistMatches = security == .allowlist
            ? ExecAllowlistMatcher.matchAll(entries: approvals.allowlist, resolutions: allowlistResolutions)
            : []
        let allowlistSatisfied = security == .allowlist &&
            !allowlistResolutions.isEmpty &&
            allowlistMatches.count == allowlistResolutions.count
        let shouldEvaluateDenylist = security == .denylist ||
            security == .allowlist ||
            (security == .full && ask == .always && approvals.agent.askFallback == .denylist)
        let denylistDenied = shouldEvaluateDenylist && ExecDenylistEvaluator.denied(
            command: command,
            displayCommand: displayCommand,
            env: env,
            denylist: approvals.denylist)

        let skillAllow: Bool
        if approvals.agent.autoAllowSkills, !allowlistResolutions.isEmpty {
            let bins = await SkillBinsCache.shared.currentTrust()
            skillAllow = self.isSkillAutoAllowed(allowlistResolutions, trustedBinsByName: bins)
        } else {
            skillAllow = false
        }

        return ExecApprovalEvaluation(
            command: command,
            displayCommand: displayCommand,
            agentId: normalizedAgentId,
            security: security,
            ask: ask,
            env: env,
            resolution: allowlistResolutions.first,
            allowlistResolutions: allowlistResolutions,
            allowAlwaysPatterns: allowAlwaysPatterns,
            allowlistMatches: allowlistMatches,
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: allowlistSatisfied ? allowlistMatches.first : nil,
            denylistDenied: denylistDenied,
            skillAllow: skillAllow)
    }

    private static func minSecurity(_ left: ExecSecurity, _ right: ExecSecurity) -> ExecSecurity {
        self.securityRank(left) <= self.securityRank(right) ? left : right
    }

    private static func maxAsk(_ left: ExecAsk, _ right: ExecAsk) -> ExecAsk {
        self.askRank(left) >= self.askRank(right) ? left : right
    }

    private static func securityRank(_ security: ExecSecurity) -> Int {
        switch security {
        case .deny: 0
        case .allowlist: 1
        case .denylist: 2
        case .full: 3
        }
    }

    private static func askRank(_ ask: ExecAsk) -> Int {
        switch ask {
        case .off: 0
        case .onMiss: 1
        case .always: 2
        }
    }

    static func isSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        guard !resolutions.isEmpty, !trustedBinsByName.isEmpty else { return false }
        return resolutions.allSatisfy { resolution in
            guard let executableName = SkillBinsCache.normalizeSkillBinName(resolution.executableName),
                  let resolvedPath = SkillBinsCache.normalizeResolvedPath(resolution.resolvedPath)
            else {
                return false
            }
            return trustedBinsByName[executableName]?.contains(resolvedPath) == true
        }
    }

    static func _testIsSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        self.isSkillAutoAllowed(resolutions, trustedBinsByName: trustedBinsByName)
    }
}
