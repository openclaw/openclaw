import Foundation

enum ExecShellWrapperParser {
    struct ParsedShellWrapper {
        let isWrapper: Bool
        let command: String?

        static let notWrapper = ParsedShellWrapper(isWrapper: false, command: nil)
    }

    private enum Kind {
        case posix
        case cmd
        case powershell
    }

    private struct WrapperSpec {
        let kind: Kind
        let names: Set<String>
    }

    private static let posixInlineFlags = Set(["-lc", "-c", "--command"])
    private static let powershellInlineFlags = Set(["-c", "-command", "--command"])

    private static let wrapperSpecs: [WrapperSpec] = [
        WrapperSpec(kind: .posix, names: ["ash", "sh", "bash", "zsh", "dash", "ksh", "fish"]),
        WrapperSpec(kind: .cmd, names: ["cmd.exe", "cmd"]),
        WrapperSpec(kind: .powershell, names: ["powershell", "powershell.exe", "pwsh", "pwsh.exe"]),
    ]

    static func extract(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw
        return self.extract(command: command, preferredRaw: preferredRaw, depth: 0)
    }

    private static func extract(command: [String], preferredRaw: String?, depth: Int) -> ParsedShellWrapper {
        guard depth < ExecEnvInvocationUnwrapper.maxWrapperDepth else {
            return .notWrapper
        }
        guard let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return .notWrapper
        }

        let base0 = ExecCommandToken.basenameLower(token0)
        if base0 == "env" {
            guard let unwrapped = ExecEnvInvocationUnwrapper.unwrap(command) else {
                return .notWrapper
            }
            return self.extract(command: unwrapped, preferredRaw: preferredRaw, depth: depth + 1)
        }

        guard let spec = self.wrapperSpecs.first(where: { $0.names.contains(base0) }) else {
            return .notWrapper
        }
        guard let payload = self.extractPayload(command: command, spec: spec) else {
            return .notWrapper
        }
        let normalized = preferredRaw ?? payload
        return ParsedShellWrapper(isWrapper: true, command: normalized)
    }

    private static func extractPayload(command: [String], spec: WrapperSpec) -> String? {
        switch spec.kind {
        case .posix:
            self.extractPosixInlineCommand(command)
        case .cmd:
            self.extractCmdInlineCommand(command)
        case .powershell:
            self.extractPowerShellInlineCommand(command)
        }
    }

    private static func extractPosixInlineCommand(_ command: [String]) -> String? {
        let flag = command.count > 1 ? command[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        guard self.posixInlineFlags.contains(flag.lowercased()) else {
            return nil
        }
        let payload = command.count > 2 ? command[2].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        return payload.isEmpty ? nil : payload
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

    private static func extractPowerShellInlineCommand(_ command: [String]) -> String? {
        for idx in 1..<command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if token.isEmpty { continue }
            if token == "--" { break }
            if self.powershellInlineFlags.contains(token) {
                let payload = idx + 1 < command.count
                    ? command[idx + 1].trimmingCharacters(in: .whitespacesAndNewlines)
                    : ""
                return payload.isEmpty ? nil : payload
            }
        }
        return nil
    }
}
