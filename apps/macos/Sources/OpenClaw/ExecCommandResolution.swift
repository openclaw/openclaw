import Foundation

struct ExecCommandResolution: Sendable {
    let rawExecutable: String
    let resolvedPath: String?
    let executableName: String
    let cwd: String?

    static func resolve(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution?
    {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedRaw.isEmpty, let token = self.parseFirstToken(trimmedRaw) {
            return self.resolveExecutable(rawExecutable: token, cwd: cwd, env: env)
        }
        return self.resolve(command: command, cwd: cwd, env: env)
    }

    static func resolveForAllowlist(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> [ExecCommandResolution]
    {
        let shell = self.extractShellCommandFromArgv(command: command, rawCommand: rawCommand)
        if shell.isWrapper {
            guard let shellCommand = shell.command,
                  let segments = self.splitShellCommandChain(shellCommand)
            else {
                // Fail closed: if we cannot safely parse a shell wrapper payload,
                // treat this as an allowlist miss and require approval.
                return []
            }
            var resolutions: [ExecCommandResolution] = []
            resolutions.reserveCapacity(segments.count)
            for segment in segments {
                guard let token = self.parseFirstToken(segment),
                      let resolution = self.resolveExecutable(rawExecutable: token, cwd: cwd, env: env)
                else {
                    return []
                }
                resolutions.append(resolution)
            }
            return resolutions
        }

        guard let resolution = self.resolve(command: command, rawCommand: rawCommand, cwd: cwd, env: env) else {
            return []
        }
        return [resolution]
    }

    static func resolve(command: [String], cwd: String?, env: [String: String]?) -> ExecCommandResolution? {
        let effective = self.unwrapDispatchWrappersForResolution(command)
        guard let raw = effective.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return self.resolveExecutable(rawExecutable: raw, cwd: cwd, env: env)
    }

    private static func resolveExecutable(
        rawExecutable: String,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution?
    {
        let expanded = rawExecutable.hasPrefix("~") ? (rawExecutable as NSString).expandingTildeInPath : rawExecutable
        let hasPathSeparator = expanded.contains("/") || expanded.contains("\\")
        let resolvedPath: String? = {
            if hasPathSeparator {
                if expanded.hasPrefix("/") {
                    return expanded
                }
                let base = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
                let root = (base?.isEmpty == false) ? base! : FileManager().currentDirectoryPath
                return URL(fileURLWithPath: root).appendingPathComponent(expanded).path
            }
            let searchPaths = self.searchPaths(from: env)
            return CommandResolver.findExecutable(named: expanded, searchPaths: searchPaths)
        }()
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? expanded
        return ExecCommandResolution(
            rawExecutable: expanded,
            resolvedPath: resolvedPath,
            executableName: name,
            cwd: cwd)
    }

    private static func parseFirstToken(_ command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let first = trimmed.first else { return nil }
        if first == "\"" || first == "'" {
            let rest = trimmed.dropFirst()
            if let end = rest.firstIndex(of: first) {
                return String(rest[..<end])
            }
            return String(rest)
        }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
    }

    private static func basenameLower(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let normalized = trimmed.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map { String($0).lowercased() } ?? normalized.lowercased()
    }

    private static func extractShellCommandFromArgv(
        command: [String],
        rawCommand: String?) -> (isWrapper: Bool, command: String?)
    {
        guard let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return (false, nil)
        }
        let base0 = self.basenameLower(token0)
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw

        if base0 == "env" {
            guard let unwrapped = self.unwrapEnvInvocation(command) else {
                return (false, nil)
            }
            return self.extractShellCommandFromArgv(command: unwrapped, rawCommand: rawCommand)
        }

        if ["ash", "sh", "bash", "zsh", "dash", "ksh", "fish"].contains(base0) {
            let flag = command.count > 1 ? command[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let normalizedFlag = flag.lowercased()
            guard normalizedFlag == "-lc" || normalizedFlag == "-c" || normalizedFlag == "--command" else {
                return (false, nil)
            }
            let payload = command.count > 2 ? command[2].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let normalized = preferredRaw ?? (payload.isEmpty ? nil : payload)
            return (true, normalized)
        }

        if base0 == "cmd.exe" || base0 == "cmd" {
            guard let idx = command
                .firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/c" })
            else {
                return (false, nil)
            }
            let tail = command.suffix(from: command.index(after: idx)).joined(separator: " ")
            let payload = tail.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = preferredRaw ?? (payload.isEmpty ? nil : payload)
            return (true, normalized)
        }

        if ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].contains(base0) {
            for idx in 1..<command.count {
                let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if token.isEmpty { continue }
                if token == "--" { break }
                if token == "-c" || token == "-command" || token == "--command" {
                    let payload = idx + 1 < command.count
                        ? command[idx + 1].trimmingCharacters(in: .whitespacesAndNewlines)
                        : ""
                    let normalized = preferredRaw ?? (payload.isEmpty ? nil : payload)
                    return (true, normalized)
                }
            }
        }

        return (false, nil)
    }

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

    private static func isEnvAssignment(_ token: String) -> Bool {
        let pattern = #"^[A-Za-z_][A-Za-z0-9_]*=.*"#
        return token.range(of: pattern, options: .regularExpression) != nil
    }

    private static func unwrapEnvInvocation(_ command: [String]) -> [String]? {
        var idx = 1
        var expectsOptionValue = false
        while idx < command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if expectsOptionValue {
                expectsOptionValue = false
                idx += 1
                continue
            }
            if token == "--" || token == "-" {
                idx += 1
                break
            }
            if self.isEnvAssignment(token) {
                idx += 1
                continue
            }
            if token.hasPrefix("-"), token != "-" {
                let lower = token.lowercased()
                let flag = lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
                if self.envFlagOptions.contains(flag) {
                    idx += 1
                    continue
                }
                if self.envOptionsWithValue.contains(flag) {
                    if !lower.contains("=") {
                        expectsOptionValue = true
                    }
                    idx += 1
                    continue
                }
                if lower.hasPrefix("-u") ||
                    lower.hasPrefix("-c") ||
                    lower.hasPrefix("-s") ||
                    lower.hasPrefix("--unset=") ||
                    lower.hasPrefix("--chdir=") ||
                    lower.hasPrefix("--split-string=") ||
                    lower.hasPrefix("--default-signal=") ||
                    lower.hasPrefix("--ignore-signal=") ||
                    lower.hasPrefix("--block-signal=")
                {
                    idx += 1
                    continue
                }
                return nil
            }
            break
        }
        guard idx < command.count else { return nil }
        return Array(command[idx...])
    }

    private static func unwrapDispatchWrappersForResolution(_ command: [String]) -> [String] {
        var current = command
        var depth = 0
        while depth < 4 {
            guard let token = current.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
                break
            }
            guard self.basenameLower(token) == "env" else {
                break
            }
            guard let unwrapped = self.unwrapEnvInvocation(current), !unwrapped.isEmpty else {
                break
            }
            current = unwrapped
            depth += 1
        }
        return current
    }

    private enum ShellTokenContext {
        case unquoted
        case doubleQuoted
    }

    private struct ShellFailClosedRule {
        let token: Character
        let next: Character?
    }

    private static let shellFailClosedRules: [ShellTokenContext: [ShellFailClosedRule]] = [
        .unquoted: [
            ShellFailClosedRule(token: "`", next: nil),
            ShellFailClosedRule(token: "$", next: "("),
            ShellFailClosedRule(token: "<", next: "("),
            ShellFailClosedRule(token: ">", next: "("),
        ],
        .doubleQuoted: [
            ShellFailClosedRule(token: "`", next: nil),
            ShellFailClosedRule(token: "$", next: "("),
        ],
    ]

    private static func splitShellCommandChain(_ command: String) -> [String]? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var segments: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false
        let chars = Array(trimmed)
        var idx = 0

        func appendCurrent() -> Bool {
            let segment = current.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !segment.isEmpty else { return false }
            segments.append(segment)
            current.removeAll(keepingCapacity: true)
            return true
        }

        while idx < chars.count {
            let ch = chars[idx]
            let next: Character? = idx + 1 < chars.count ? chars[idx + 1] : nil

            if escaped {
                current.append(ch)
                escaped = false
                idx += 1
                continue
            }

            if ch == "\\", !inSingle {
                current.append(ch)
                escaped = true
                idx += 1
                continue
            }

            if ch == "'", !inDouble {
                inSingle.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if ch == "\"", !inSingle {
                inDouble.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if !inSingle, self.shouldFailClosedForShell(ch: ch, next: next, inDouble: inDouble) {
                // Fail closed on command/process substitution in allowlist mode,
                // including command substitution inside double-quoted shell strings.
                return nil
            }

            if !inSingle, !inDouble {
                let prev: Character? = idx > 0 ? chars[idx - 1] : nil
                if let delimiterStep = self.chainDelimiterStep(ch: ch, prev: prev, next: next) {
                    guard appendCurrent() else { return nil }
                    idx += delimiterStep
                    continue
                }
            }

            current.append(ch)
            idx += 1
        }

        if escaped || inSingle || inDouble { return nil }
        guard appendCurrent() else { return nil }
        return segments
    }

    private static func shouldFailClosedForShell(ch: Character, next: Character?, inDouble: Bool) -> Bool {
        let context: ShellTokenContext = inDouble ? .doubleQuoted : .unquoted
        guard let rules = self.shellFailClosedRules[context] else {
            return false
        }
        for rule in rules {
            if ch == rule.token, rule.next == nil || next == rule.next {
                return true
            }
        }
        return false
    }

    private static func chainDelimiterStep(ch: Character, prev: Character?, next: Character?) -> Int? {
        if ch == ";" || ch == "\n" {
            return 1
        }
        if ch == "&" {
            if next == "&" {
                return 2
            }
            // Keep fd redirections like 2>&1 or &>file intact.
            let prevIsRedirect = prev == ">"
            let nextIsRedirect = next == ">"
            return (!prevIsRedirect && !nextIsRedirect) ? 1 : nil
        }
        if ch == "|" {
            if next == "|" || next == "&" {
                return 2
            }
            return 1
        }
        return nil
    }

    private static func searchPaths(from env: [String: String]?) -> [String] {
        let raw = env?["PATH"]
        if let raw, !raw.isEmpty {
            return raw.split(separator: ":").map(String.init)
        }
        return CommandResolver.preferredPaths()
    }
}

enum ExecCommandFormatter {
    static func displayString(for argv: [String]) -> String {
        argv.map { arg in
            let trimmed = arg.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return "\"\"" }
            let needsQuotes = trimmed.contains { $0.isWhitespace || $0 == "\"" }
            if !needsQuotes { return trimmed }
            let escaped = trimmed.replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        }.joined(separator: " ")
    }

    static func displayString(for argv: [String], rawCommand: String?) -> String {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return self.displayString(for: argv)
    }
}
