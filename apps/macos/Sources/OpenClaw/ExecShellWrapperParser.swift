import Foundation

enum ExecShellWrapperParser {
    struct ParsedShellWrapper {
        let isWrapper: Bool
        let command: String?

        static let notWrapper = ParsedShellWrapper(isWrapper: false, command: nil)
        static let blockedWrapper = ParsedShellWrapper(isWrapper: true, command: nil)
    }

    private enum Kind: Equatable {
        case posix
        case cmd
        case powershell
    }

    private static let posixInlineFlags = Set(["-lc", "-c", "--command"])
    private static let powershellInlineFlags = Set(["-c", "-command", "--command"])

    private static func kind(for name: String) -> Kind? {
        switch name {
        case "ash", "sh", "bash", "zsh", "dash", "ksh", "fish": .posix
        case "cmd.exe", "cmd": .cmd
        case "powershell", "powershell.exe", "pwsh", "pwsh.exe": .powershell
        default: nil
        }
    }

    static func isShellWrapperExecutable(_ token: String) -> Bool {
        let name = ExecCommandToken.basenameLower(token)
        return self.kind(for: name) != nil
    }

    static func extract(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        self.extract(
            command: command,
            rawCommand: rawCommand,
            failClosedOnStartupWrappers: false,
            depth: 0)
    }

    static func extractForAllowlist(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        self.extract(
            command: command,
            rawCommand: rawCommand,
            failClosedOnStartupWrappers: true,
            depth: 0)
    }

    private static func extract(
        command: [String],
        rawCommand: String?,
        failClosedOnStartupWrappers: Bool,
        depth: Int) -> ParsedShellWrapper
    {
        guard depth < ExecEnvInvocationUnwrapper.maxWrapperDepth else {
            return .notWrapper
        }
        guard let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return .notWrapper
        }

        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw
        let base0 = ExecCommandToken.basenameLower(token0)
        if base0 == "env" {
            guard let unwrapped = ExecEnvInvocationUnwrapper.unwrap(command) else {
                return .notWrapper
            }
            return self.extract(
                command: unwrapped,
                rawCommand: preferredRaw,
                failClosedOnStartupWrappers: failClosedOnStartupWrappers,
                depth: depth + 1)
        }

        guard let kind = self.kind(for: base0) else {
            return .notWrapper
        }
        if base0 == "fish",
           ExecInlineCommandParser.hasFishAttachedCommandOption(command)
        {
            return .blockedWrapper
        }
        let includeLegacyLoginInlineForm = failClosedOnStartupWrappers &&
            !self.legacyLoginInlinePayloadMatchesRaw(
                command: command,
                kind: kind,
                base0: base0,
                preferredRaw: preferredRaw)
        if self.startupWrapperRequiresFullArgv(
            command: command,
            kind: kind,
            base0: base0,
            includeLegacyLoginInlineForm: includeLegacyLoginInlineForm)
        {
            return .blockedWrapper
        }
        guard let payload = extractPayload(command: command, kind: kind) else {
            return .notWrapper
        }
        let normalized = failClosedOnStartupWrappers ? payload : preferredRaw ?? payload
        return ParsedShellWrapper(isWrapper: true, command: normalized)
    }

    private static func startupWrapperRequiresFullArgv(
        command: [String],
        kind: Kind,
        base0: String,
        includeLegacyLoginInlineForm: Bool) -> Bool
    {
        guard kind == .posix else {
            return false
        }
        if base0 == "fish",
           ExecInlineCommandParser.hasFishInitCommandOption(command)
        {
            return true
        }
        if ExecInlineCommandParser.hasPosixLoginStartupBeforeInlineCommand(command, flags: self.posixInlineFlags) {
            return includeLegacyLoginInlineForm || !(base0 == "sh" && self.isLegacyLoginInlineForm(command))
        }
        return ExecInlineCommandParser.hasPosixInteractiveStartupBeforeInlineCommand(
            command,
            flags: self.posixInlineFlags)
    }

    private static func isLegacyLoginInlineForm(_ command: [String]) -> Bool {
        guard command.count > 1 else {
            return false
        }
        return command[1].trimmingCharacters(in: .whitespacesAndNewlines) == "-lc"
    }

    private static func legacyLoginInlinePayloadMatchesRaw(
        command: [String],
        kind: Kind,
        base0: String,
        preferredRaw: String?) -> Bool
    {
        guard let preferredRaw,
              base0 == "sh",
              isLegacyLoginInlineForm(command),
              let payload = extractPayload(command: command, kind: kind)
        else {
            return false
        }
        return payload == preferredRaw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractPayload(command: [String], kind: Kind) -> String? {
        switch kind {
        case .posix:
            ExecInlineCommandParser.extractInlineCommand(command, flags: self.posixInlineFlags, allowCombinedC: true)
        case .cmd:
            self.extractCmdInlineCommand(command)
        case .powershell:
            ExecInlineCommandParser.extractInlineCommand(
                command, flags: self.powershellInlineFlags, allowCombinedC: false)
        }
    }

    private static func extractCmdInlineCommand(_ command: [String]) -> String? {
        guard let idx = command
            .firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/c" })
        else {
            return nil
        }
        let tail = command.suffix(from: command.index(after: idx)).joined(separator: " ")
        let payload = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        return payload.isEmpty ? nil : payload
    }
}
