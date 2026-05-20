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
    private static let maxRules = 256
    private static let maxPatternLength = 8 * 1024
    private static let maxInspectedCharacters = 256 * 1024
    private static let allowedFlags = Set(["i", "m", "u"])

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
            min(self.maxInspectedCharacters + 1, total + candidate.count)
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
                let range = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
                if regex.firstMatch(in: candidate, options: [], range: range) != nil {
                    return true
                }
            }
        }
        return false
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
        env: [String: String]) -> [String]
    {
        var values: [String] = []
        var expansionEnv = env
        self.push(&values, displayCommand)
        self.push(&values, command.joined(separator: " "))
        for arg in command {
            self.push(&values, arg)
            self.push(&values, self.inlineEnvAssignmentValue(arg))
            if let assignment = self.inlineEnvAssignment(arg) {
                expansionEnv[assignment.name] = assignment.value
            }
        }
        for candidate in self.shellPayloadCandidates(command: command) {
            self.push(&values, candidate)
        }
        for line in displayCommand.components(separatedBy: .newlines) {
            self.push(&values, line)
        }
        for reference in self.envReferences(in: displayCommand) {
            if let value = self.resolveEnv(env, reference: reference) {
                self.push(&values, value)
            }
        }
        for value in values {
            self.push(&values, self.expandEnvReferences(in: value, env: expansionEnv))
        }
        return Array(Set(values))
    }

    private static func push(_ values: inout [String], _ value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            values.append(trimmed)
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

    private static func shellPayloadCandidates(command: [String]) -> [String] {
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        guard shell.isWrapper, let payload = shell.command else { return [] }
        let words = self.splitShellWords(payload)
        return words + [words.joined(separator: " ")]
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
                self.push(&words, current)
                current = ""
                continue
            }
            current.append(char)
        }
        if escaped {
            current.append("\\")
        }
        self.push(&words, current)
        return words
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
        agentId: String?) async -> ExecApprovalEvaluation
    {
        let trimmedAgent = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAgentId = (trimmedAgent?.isEmpty == false) ? trimmedAgent : nil
        let approvals = ExecApprovalsStore.resolve(agentId: normalizedAgentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
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
