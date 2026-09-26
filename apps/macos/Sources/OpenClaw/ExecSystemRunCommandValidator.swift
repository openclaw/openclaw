import Foundation

enum ExecSystemRunCommandValidator {
    struct ResolvedCommand {
        let displayCommand: String
        let evaluationRawCommand: String?
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

    static func resolve(command: [String], rawCommand: String?) -> ValidationResult {
        let normalizedRaw = self.trimmedNonEmpty(rawCommand)
        let shell = self.displayShell(command)
        let canonicalDisplay = ExecCommandFormatter.displayString(for: command)

        if let raw = normalizedRaw {
            let matchesCanonical = raw == canonicalDisplay
            let matchesLegacyCanonical = raw == ExecCommandFormatter.legacyDisplayString(for: command)
            let matchesLegacyShellText = shell.command == raw
            if !matchesCanonical, !matchesLegacyCanonical, !matchesLegacyShellText {
                return .invalid(message: "INVALID_REQUEST: rawCommand does not match command")
            }
        }

        return .ok(ResolvedCommand(
            displayCommand: canonicalDisplay,
            evaluationRawCommand: self.allowlistEvaluationRawCommand(
                normalizedRaw: normalizedRaw,
                shellIsWrapper: shell.isWrapper,
                previewCommand: shell.command)))
    }

    static func allowlistEvaluationRawCommand(command: [String], rawCommand: String?) -> String? {
        let normalizedRaw = self.trimmedNonEmpty(rawCommand)
        let shell = self.displayShell(command)

        return self.allowlistEvaluationRawCommand(
            normalizedRaw: normalizedRaw,
            shellIsWrapper: shell.isWrapper,
            previewCommand: shell.command)
    }

    private static func displayShell(_ command: [String]) -> ExecShellWrapperParser.ParsedShellWrapper {
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        let envManipulation = self.hasEnvManipulationBeforeShellWrapper(command)
        let positionalArguments = self.hasTrailingPositionalArgvAfterInlineCommand(command)
        return .init(
            isWrapper: shell.isWrapper,
            command: shell.isWrapper && !envManipulation && !positionalArguments
                ? self.trimmedNonEmpty(shell.command)
                : nil)
    }

    private static func trimmedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func allowlistEvaluationRawCommand(
        normalizedRaw: String?,
        shellIsWrapper: Bool,
        previewCommand: String?) -> String?
    {
        guard shellIsWrapper else {
            return normalizedRaw
        }
        guard let normalizedRaw else {
            return nil
        }
        return normalizedRaw == previewCommand ? normalizedRaw : nil
    }

    private static func normalizeExecutableToken(_ token: String) -> String {
        let base = ExecCommandToken.basenameLower(token)
        if base.hasSuffix(".exe") {
            return String(base.dropLast(4))
        }
        return base
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

    static func hasEnvManipulationBeforeShellWrapper(
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
            guard let envUnwrap = ExecEnvInvocationUnwrapper.unwrapWithMetadata(argv, skippingEmptyArguments: true)
            else {
                return false
            }
            return self.hasEnvManipulationBeforeShellWrapper(
                envUnwrap.command,
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
                guard let envUnwrap = ExecEnvInvocationUnwrapper.unwrapWithMetadata(
                    current,
                    skippingEmptyArguments: true),
                    !envUnwrap.usesModifiers,
                    !envUnwrap.command.isEmpty
                else {
                    break
                }
                current = envUnwrap.command
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
        guard let match = ExecInlineCommandParser.findMatch(argv, flags: flags, allowCombinedC: allowCombinedC) else {
            return nil
        }
        if match.inlineCommand != nil {
            return match.tokenIndex
        }
        let nextIndex = match.tokenIndex + match.valueTokenOffset
        return nextIndex < argv.count ? nextIndex : nil
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
        guard let match = ExecInlineCommandParser.findMatch(argv, flags: flags, allowCombinedC: allowCombinedC) else {
            return nil
        }
        if let inlineCommand = match.inlineCommand {
            return inlineCommand
        }
        let nextIndex = match.tokenIndex + match.valueTokenOffset
        return self.trimmedNonEmpty(nextIndex < argv.count ? argv[nextIndex] : nil)
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
