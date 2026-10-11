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

    static func resolve(command: [String], rawCommand: String?) -> ValidationResult {
        let normalizedRaw = rawCommand?.nonEmpty
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
        let normalizedRaw = rawCommand?.nonEmpty
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
                ? shell.command?.nonEmpty
                : nil)
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

    static func hasEnvManipulationBeforeShellWrapper(
        _ argv: [String],
        depth: Int = 0,
        envManipulationSeen: Bool = false) -> Bool
    {
        if depth >= ExecEnvInvocationUnwrapper.maxWrapperDepth {
            return false
        }
        guard let token0 = argv.first?.nonEmpty else {
            return false
        }

        let normalized = ExecShellMultiplexer.normalizedExecutable(token0)
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

        if let shellMultiplexer = ExecShellMultiplexer.unwrap(argv, policy: .validation) {
            return self.hasEnvManipulationBeforeShellWrapper(
                shellMultiplexer,
                depth: depth + 1,
                envManipulationSeen: envManipulationSeen)
        }

        guard ExecShellMultiplexer.isValidationShell(normalized) else {
            return false
        }
        guard self.extractShellInlinePayload(argv, normalizedWrapper: normalized) != nil else {
            return false
        }
        return envManipulationSeen
    }

    private static func hasTrailingPositionalArgvAfterInlineCommand(_ argv: [String]) -> Bool {
        let wrapperArgv = self.unwrapShellWrapperArgv(argv)
        guard let token0 = wrapperArgv.first?.nonEmpty else {
            return false
        }
        let wrapper = ExecShellMultiplexer.normalizedExecutable(token0)
        guard wrapper != "cmd", ExecShellMultiplexer.isValidationShell(wrapper) else {
            return false
        }

        let isPowerShell = wrapper == "powershell" || wrapper == "pwsh"
        let match = ExecInlineCommandParser.findMatch(
            wrapperArgv,
            flags: isPowerShell ? ExecShellWrapperParser.powershellInlineFlags : ExecShellWrapperParser
                .posixInlineFlags,
            allowCombinedC: !isPowerShell)
        guard let match else {
            return false
        }
        let start = match.valueTokenIndex + 1
        guard start < wrapperArgv.count else {
            return false
        }
        return wrapperArgv[start...].contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func unwrapShellWrapperArgv(_ argv: [String]) -> [String] {
        var current = argv
        for _ in 0..<ExecEnvInvocationUnwrapper.maxWrapperDepth {
            guard let token0 = current.first?.nonEmpty else {
                break
            }
            let normalized = ExecShellMultiplexer.normalizedExecutable(token0)
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
            if let shellMultiplexer = ExecShellMultiplexer.unwrap(current, policy: .validation) {
                current = shellMultiplexer
                continue
            }
            break
        }
        return current
    }

    private static func extractShellInlinePayload(
        _ argv: [String],
        normalizedWrapper: String) -> String?
    {
        if normalizedWrapper == "cmd" {
            return ExecShellWrapperParser.extractCmdInlineCommand(argv, allowKeepAlive: true)
        }
        let isPowerShell = normalizedWrapper == "powershell" || normalizedWrapper == "pwsh"
        return ExecInlineCommandParser.extractInlineCommand(
            argv,
            flags: isPowerShell ? ExecShellWrapperParser.powershellInlineFlags : ExecShellWrapperParser
                .posixInlineFlags,
            allowCombinedC: !isPowerShell)?.nonEmpty
    }
}
