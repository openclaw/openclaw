import Foundation

enum ExecSystemRunCommandValidator {
    struct ResolvedCommand {
        let displayCommand: String
    }

    enum ValidationResult {
        case ok(ResolvedCommand)
        case invalid(message: String)
    }

    private static let shellWrapperNames = Set([
        "ash",
        "bash",
        "cmd",
        "dash",
        "fish",
        "ksh",
        "powershell",
        "pwsh",
        "sh",
        "zsh",
    ])

    private static let posixOrPowerShellInlineWrapperNames = Set([
        "ash",
        "bash",
        "dash",
        "fish",
        "ksh",
        "powershell",
        "pwsh",
        "sh",
        "zsh",
    ])

    private static let shellMultiplexerWrapperNames = Set(["busybox", "toybox"])
    private static let posixInlineCommandFlags = Set(["-lc", "-c", "--command"])
    private static let powershellInlineCommandFlags = Set(["-c", "-command", "--command"])

    private static let envOptionsWithValue = Set([
        "-u",
        "--unset",
        "-c",
        "--chdir",
        "-s",
        "--split-string",
        "--default-signal",
        "--ignore-signal",
        "--block-signal",
    ])
    private static let envFlagOptions = Set(["-i", "--ignore-environment", "-0", "--null"])
    private static let envInlineValuePrefixes = [
        "-u",
        "-c",
        "-s",
        "--unset=",
        "--chdir=",
        "--split-string=",
        "--default-signal=",
        "--ignore-signal=",
        "--block-signal=",
    ]

    private struct EnvUnwrapResult {
        let argv: [String]
        let usesModifiers: Bool
    }

    static func resolve(command: [String], rawCommand: String?) -> ValidationResult {
        let normalizedRaw = self.normalizeRaw(rawCommand)
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        let shellCommand = shell.isWrapper ? self.trimmedNonEmpty(shell.command) : nil

        let envManipulationBeforeShellWrapper = self.hasEnvManipulationBeforeShellWrapper(command)
        let shellWrapperPositionalArgv = self.hasTrailingPositionalArgvAfterInlineCommand(command)
        let mustBindDisplayToFullArgv = envManipulationBeforeShellWrapper || shellWrapperPositionalArgv

        let inferred: String = if let shellCommand, !mustBindDisplayToFullArgv {
            shellCommand
        } else {
            ExecCommandFormatter.displayString(for: command)
        }

        if let raw = normalizedRaw, raw != inferred {
            return .invalid(message: "INVALID_REQUEST: rawCommand does not match command")
        }

        return .ok(ResolvedCommand(displayCommand: normalizedRaw ?? inferred))
    }

    private static func normalizeRaw(_ rawCommand: String?) -> String? {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func trimmedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizeExecutableToken(_ token: String) -> String {
        let base = ExecCommandToken.basenameLower(token)
        if base.hasSuffix(".exe") {
            return String(base.dropLast(4))
        }
        return base
    }

    private static func isEnvAssignment(_ token: String) -> Bool {
        token.range(of: #"^[A-Za-z_][A-Za-z0-9_]*=.*"#, options: .regularExpression) != nil
    }

    private static func hasEnvInlineValuePrefix(_ lowerToken: String) -> Bool {
        self.envInlineValuePrefixes.contains { lowerToken.hasPrefix($0) }
    }

    private static func unwrapEnvInvocationWithMetadata(_ argv: [String]) -> EnvUnwrapResult? {
        var idx = 1
        var expectsOptionValue = false
        var usesModifiers = false

        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if expectsOptionValue {
                expectsOptionValue = false
                usesModifiers = true
                idx += 1
                continue
            }
            if token == "--" || token == "-" {
                idx += 1
                break
            }
            if self.isEnvAssignment(token) {
                usesModifiers = true
                idx += 1
                continue
            }
            if !token.hasPrefix("-") || token == "-" {
                break
            }

            let lower = token.lowercased()
            let flag = lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
            if self.envFlagOptions.contains(flag) {
                usesModifiers = true
                idx += 1
                continue
            }
            if self.envOptionsWithValue.contains(flag) {
                usesModifiers = true
                if !lower.contains("=") {
                    expectsOptionValue = true
                }
                idx += 1
                continue
            }
            if self.hasEnvInlineValuePrefix(lower) {
                usesModifiers = true
                idx += 1
                continue
            }
            return nil
        }

        if expectsOptionValue {
            return nil
        }
        guard idx < argv.count else {
            return nil
        }
        return EnvUnwrapResult(argv: Array(argv[idx...]), usesModifiers: usesModifiers)
    }

    private static func unwrapShellMultiplexerInvocation(_ argv: [String]) -> [String]? {
        guard let token0 = self.trimmedNonEmpty(argv.first) else {
            return nil
        }
        let wrapper = self.normalizeExecutableToken(token0)
        guard self.shellMultiplexerWrapperNames.contains(wrapper) else {
            return nil
        }

        var appletIndex = 1
        if appletIndex < argv.count, argv[appletIndex].trimmingCharacters(in: .whitespacesAndNewlines) == "--" {
            appletIndex += 1
        }
        guard appletIndex < argv.count else {
            return nil
        }
        let applet = argv[appletIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !applet.isEmpty else {
            return nil
        }
        let normalizedApplet = self.normalizeExecutableToken(applet)
        guard self.shellWrapperNames.contains(normalizedApplet) else {
            return nil
        }
        return Array(argv[appletIndex...])
    }

    private static func hasEnvManipulationBeforeShellWrapper(
        _ argv: [String],
        depth: Int = 0,
        envManipulationSeen: Bool = false) -> Bool
    {
        if depth >= ExecEnvInvocationUnwrapper.maxWrapperDepth {
            return false
        }
        guard let token0 = self.trimmedNonEmpty(argv.first) else {
            return false
        }

        let normalized = self.normalizeExecutableToken(token0)
        if normalized == "env" {
            guard let envUnwrap = self.unwrapEnvInvocationWithMetadata(argv) else {
                return false
            }
            return self.hasEnvManipulationBeforeShellWrapper(
                envUnwrap.argv,
                depth: depth + 1,
                envManipulationSeen: envManipulationSeen || envUnwrap.usesModifiers)
        }

        if let shellMultiplexer = self.unwrapShellMultiplexerInvocation(argv) {
            return self.hasEnvManipulationBeforeShellWrapper(
                shellMultiplexer,
                depth: depth + 1,
                envManipulationSeen: envManipulationSeen)
        }

        guard self.shellWrapperNames.contains(normalized) else {
            return false
        }
        guard self.extractShellInlinePayload(argv, normalizedWrapper: normalized) != nil else {
            return false
        }
        return envManipulationSeen
    }

    private static func hasTrailingPositionalArgvAfterInlineCommand(_ argv: [String]) -> Bool {
        let wrapperArgv = self.unwrapShellWrapperArgv(argv)
        guard let token0 = self.trimmedNonEmpty(wrapperArgv.first) else {
            return false
        }
        let wrapper = self.normalizeExecutableToken(token0)
        guard self.posixOrPowerShellInlineWrapperNames.contains(wrapper) else {
            return false
        }

        let inlineCommandIndex: Int? = if wrapper == "powershell" || wrapper == "pwsh" {
            self.resolveInlineCommandTokenIndex(
                wrapperArgv,
                flags: self.powershellInlineCommandFlags,
                allowCombinedC: false)
        } else {
            self.resolveInlineCommandTokenIndex(
                wrapperArgv,
                flags: self.posixInlineCommandFlags,
                allowCombinedC: true)
        }
        guard let inlineCommandIndex else {
            return false
        }
        let start = inlineCommandIndex + 1
        guard start < wrapperArgv.count else {
            return false
        }
        return wrapperArgv[start...].contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func unwrapShellWrapperArgv(_ argv: [String]) -> [String] {
        var current = argv
        for _ in 0..<ExecEnvInvocationUnwrapper.maxWrapperDepth {
            guard let token0 = self.trimmedNonEmpty(current.first) else {
                break
            }
            let normalized = self.normalizeExecutableToken(token0)
            if normalized == "env" {
                guard let envUnwrap = self.unwrapEnvInvocationWithMetadata(current),
                      !envUnwrap.usesModifiers,
                      !envUnwrap.argv.isEmpty
                else {
                    break
                }
                current = envUnwrap.argv
                continue
            }
            if let shellMultiplexer = self.unwrapShellMultiplexerInvocation(current) {
                current = shellMultiplexer
                continue
            }
            break
        }
        return current
    }

    private static func resolveInlineCommandTokenIndex(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> Int?
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
                return idx + 1 < argv.count ? idx + 1 : nil
            }
            if allowCombinedC, let inlineOffset = self.combinedCommandInlineOffset(token) {
                let inline = String(token.dropFirst(inlineOffset))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !inline.isEmpty {
                    return idx
                }
                return idx + 1 < argv.count ? idx + 1 : nil
            }
            idx += 1
        }
        return nil
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

    private static func extractShellInlinePayload(
        _ argv: [String],
        normalizedWrapper: String) -> String?
    {
        if normalizedWrapper == "cmd" {
            return self.extractCmdInlineCommand(argv)
        }
        if normalizedWrapper == "powershell" || normalizedWrapper == "pwsh" {
            return self.extractInlineCommandByFlags(
                argv,
                flags: self.powershellInlineCommandFlags,
                allowCombinedC: false)
        }
        return self.extractInlineCommandByFlags(
            argv,
            flags: self.posixInlineCommandFlags,
            allowCombinedC: true)
    }

    private static func extractInlineCommandByFlags(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> String?
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
                return self.trimmedNonEmpty(idx + 1 < argv.count ? argv[idx + 1] : nil)
            }
            if allowCombinedC, let inlineOffset = self.combinedCommandInlineOffset(token) {
                let inline = String(token.dropFirst(inlineOffset))
                if let inlineValue = self.trimmedNonEmpty(inline) {
                    return inlineValue
                }
                return self.trimmedNonEmpty(idx + 1 < argv.count ? argv[idx + 1] : nil)
            }
            idx += 1
        }
        return nil
    }

    private static func extractCmdInlineCommand(_ argv: [String]) -> String? {
        guard let idx = argv.firstIndex(where: {
            let token = $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return token == "/c" || token == "/k"
        }) else {
            return nil
        }
        let tailIndex = idx + 1
        guard tailIndex < argv.count else {
            return nil
        }
        let payload = argv[tailIndex...].joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return payload.isEmpty ? nil : payload
    }
}
