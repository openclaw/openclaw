import Foundation

struct ExecCommandResolution {
    let rawExecutable: String
    let resolvedPath: String?
    let resolvedRealPath: String?
    let executableName: String
    let cwd: String?
    let argv: [String]?

    init(
        rawExecutable: String,
        resolvedPath: String?,
        resolvedRealPath: String? = nil,
        executableName: String,
        cwd: String?,
        argv: [String]? = nil
    ) {
        self.rawExecutable = rawExecutable
        self.resolvedPath = resolvedPath
        self.resolvedRealPath = resolvedRealPath
        self.executableName = executableName
        self.cwd = cwd
        self.argv = argv
    }

    static func resolve(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?
    ) -> ExecCommandResolution? {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedRaw.isEmpty, let token = parseFirstToken(trimmedRaw) {
            let argv = command.isEmpty ? nil : [token] + Array(command.dropFirst())
            return resolveExecutable(rawExecutable: token, argv: argv, cwd: cwd, env: env)
        }
        return resolve(command: command, cwd: cwd, env: env)
    }

    static func resolveForAllowlist(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?
    ) -> [ExecCommandResolution] {
        // Allowlist resolution must follow actual argv execution for wrappers.
        // `rawCommand` is caller-supplied display text and may be canonicalized.
        let shell = ExecShellWrapperParser.extractForAllowlist(command: command, rawCommand: rawCommand)
        if shell.isWrapper {
            // Fail closed when env modifiers precede a shell wrapper. This mirrors
            // system-run binding behavior where such invocations must stay bound to
            // full argv and must not be auto-allowlisted by payload-only matches.
            if ExecSystemRunCommandValidator.hasEnvManipulationBeforeShellWrapper(command) {
                return []
            }
            guard let shellCommand = shell.command,
                  let segments = splitShellCommandChain(shellCommand)
            else {
                // Fail closed: if we cannot safely parse a shell wrapper payload,
                // treat this as an allowlist miss and require approval.
                return []
            }
            var resolutions: [ExecCommandResolution] = []
            resolutions.reserveCapacity(segments.count)
            for segment in segments {
                guard let resolution = resolveShellSegmentExecutable(segment, cwd: cwd, env: env)
                else {
                    return []
                }
                resolutions.append(resolution)
            }
            return resolutions
        }

        guard let resolution = resolveForAllowlistCommand(
            command: command,
            cwd: cwd,
            env: env
        )
        else {
            return []
        }
        return [resolution]
    }

    static func resolveAllowAlwaysPatterns(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        rawCommand: String? = nil
    ) -> [String] {
        var patterns: [String] = []
        var seen = Set<String>()
        collectAllowAlwaysPatterns(
            command: command,
            cwd: cwd,
            env: env,
            rawCommand: rawCommand,
            depth: 0,
            patterns: &patterns,
            seen: &seen
        )
        return patterns
    }

    /// Reusable authorization must execute the same canonical executable that
    /// was matched. Shell wrappers and dispatch carriers stay approval-gated:
    /// rebinding them can drop execution modes or reinterpret their operands.
    static func bindForAllowlistExecution(
        command: [String],
        rawCommand: String?,
        resolutions: [ExecCommandResolution]
    ) -> [String]? {
        guard !ExecShellWrapperParser.extractForAllowlist(
            command: command,
            rawCommand: rawCommand
        ).isWrapper else { return nil }
        guard resolutions.count == 1,
              let resolution = resolutions.first,
              let realPath = resolution.resolvedRealPath,
              FileManager().isExecutableFile(atPath: realPath),
              let argv = resolution.argv,
              !argv.isEmpty
        else { return nil }
        guard !isUnsafeReusableExecutionTarget(resolution) else { return nil }
        return [realPath] + Array(argv.dropFirst())
    }

    static func isUnsafeReusableExecutionTarget(_ resolution: ExecCommandResolution) -> Bool {
        [resolution.rawExecutable, resolution.resolvedPath, resolution.resolvedRealPath]
            .compactMap { $0 }
            .map(ExecCommandToken.basenameLower)
            .contains {
                ExecShellWrapperParser.isShellWrapperExecutable($0) ||
                    self.unsafeReusableDispatchCarrierNames.contains($0)
            }
    }

    static func resolve(command: [String], cwd: String?, env: [String: String]?) -> ExecCommandResolution? {
        let effective = ExecEnvInvocationUnwrapper.unwrapTransparentDispatchWrappersForResolution(command)
        guard let raw = effective.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return resolveExecutable(rawExecutable: raw, argv: effective, cwd: cwd, env: env)
    }

    private static func resolveForAllowlistCommand(
        command: [String],
        cwd: String?,
        env: [String: String]?
    ) -> ExecCommandResolution? {
        let effective = ExecEnvInvocationUnwrapper.unwrapDispatchWrappersForResolution(command)
        guard let raw = effective.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return resolveExecutable(rawExecutable: raw, argv: effective, cwd: cwd, env: env)
    }

    private static func resolveExecutable(
        rawExecutable: String,
        argv: [String]?,
        cwd: String?,
        env: [String: String]?
    ) -> ExecCommandResolution? {
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
        let normalizedPath = resolvedPath.map { URL(fileURLWithPath: $0).standardizedFileURL.path }
        let resolvedRealPath = normalizedPath.map {
            URL(fileURLWithPath: $0).resolvingSymlinksInPath().standardizedFileURL.path
        }
        let name = normalizedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? expanded
        return ExecCommandResolution(
            rawExecutable: expanded,
            resolvedPath: normalizedPath,
            resolvedRealPath: resolvedRealPath,
            executableName: name,
            cwd: cwd,
            argv: argv
        )
    }

    private static func resolveShellSegmentExecutable(
        _ segment: String,
        cwd: String?,
        env: [String: String]?
    ) -> ExecCommandResolution? {
        let tokens = tokenizeShellWords(segment)
        guard !tokens.isEmpty else { return nil }
        let effective = ExecEnvInvocationUnwrapper.unwrapDispatchWrappersForResolution(tokens)
        guard let raw = effective.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return resolveExecutable(rawExecutable: raw, argv: effective, cwd: cwd, env: env)
    }

    private static func collectAllowAlwaysPatterns(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        rawCommand: String?,
        depth: Int,
        patterns: inout [String],
        seen: inout Set<String>
    ) {
        guard depth < 3, !command.isEmpty else {
            return
        }

        if let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines),
           ExecCommandToken.basenameLower(token0) == "env",
           let envUnwrapped = ExecEnvInvocationUnwrapper.unwrapWithMetadata(command),
           !envUnwrapped.command.isEmpty
        {
            if envUnwrapped.usesModifiers,
               isAllowlistShellWrapper(command: envUnwrapped.command, rawCommand: rawCommand)
            {
                return
            }
            collectAllowAlwaysPatterns(
                command: envUnwrapped.command,
                cwd: cwd,
                env: env,
                rawCommand: rawCommand,
                depth: depth + 1,
                patterns: &patterns,
                seen: &seen
            )
            return
        }

        if let shellMultiplexer = unwrapShellMultiplexerInvocation(command) {
            collectAllowAlwaysPatterns(
                command: shellMultiplexer,
                cwd: cwd,
                env: env,
                rawCommand: rawCommand,
                depth: depth + 1,
                patterns: &patterns,
                seen: &seen
            )
            return
        }

        let shell = ExecShellWrapperParser.extractForAllowlist(command: command, rawCommand: rawCommand)
        if shell.isWrapper {
            guard let shellCommand = shell.command,
                  let segments = splitShellCommandChain(shellCommand)
            else {
                return
            }
            for segment in segments {
                let tokens = tokenizeShellWords(segment)
                guard !tokens.isEmpty else {
                    continue
                }
                collectAllowAlwaysPatterns(
                    command: tokens,
                    cwd: cwd,
                    env: env,
                    rawCommand: nil,
                    depth: depth + 1,
                    patterns: &patterns,
                    seen: &seen
                )
            }
            return
        }

        guard let resolution = resolve(command: command, cwd: cwd, env: env),
              let pattern = ExecApprovalHelpers.allowlistPattern(command: command, resolution: resolution),
              seen.insert(pattern).inserted
        else {
            return
        }
        patterns.append(pattern)
    }

    private static func isAllowlistShellWrapper(command: [String], rawCommand: String?) -> Bool {
        ExecShellWrapperParser.extractForAllowlist(command: command, rawCommand: rawCommand).isWrapper
    }

    private static func unwrapShellMultiplexerInvocation(_ argv: [String]) -> [String]? {
        guard let token0 = argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return nil
        }
        let wrapper = ExecCommandToken.basenameLower(token0)
        guard wrapper == "busybox" || wrapper == "toybox" else {
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

        let normalizedApplet = ExecCommandToken.basenameLower(applet)
        let shellWrappers = Set([
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
        guard shellWrappers.contains(normalizedApplet) else {
            return nil
        }
        return Array(argv[appletIndex...])
    }

    private static func parseFirstToken(_ command: String) -> String? {
        let trimmed = trimmingShellWordSeparators(command)
        guard !trimmed.isEmpty else { return nil }
        guard let first = trimmed.first else { return nil }
        if first == "\"" || first == "'" {
            let rest = trimmed.dropFirst()
            if let end = rest.firstIndex(of: first) {
                return String(rest[..<end])
            }
            return String(rest)
        }
        return trimmed.split(whereSeparator: isShellWordSeparator).first.map(String.init)
    }

    private static let unsafeReusableDispatchCarrierNames = Set([
        "arch",
        "busybox",
        "bun",
        "bunx",
        "caffeinate",
        "chrt",
        "deno",
        "doas",
        "env",
        "flock",
        "ionice",
        "nice",
        "nohup",
        "npm",
        "npx",
        "pnpm",
        "sandbox-exec",
        "script",
        "setsid",
        "stdbuf",
        "sudo",
        "taskset",
        "time",
        "timeout",
        "toybox",
        "xcrun",
        "yarn",
    ])

    private static func tokenizeShellWords(_ command: String) -> [String] {
        let trimmed = trimmingShellWordSeparators(command)
        guard !trimmed.isEmpty else { return [] }

        var tokens: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false
        var tokenStarted = false

        func appendCurrent() {
            guard tokenStarted else { return }
            tokens.append(current)
            current.removeAll(keepingCapacity: true)
            tokenStarted = false
        }

        for ch in trimmed {
            if escaped {
                current.append(ch)
                tokenStarted = true
                escaped = false
                continue
            }

            if ch == "\\", !inSingle {
                tokenStarted = true
                escaped = true
                continue
            }

            if ch == "'", !inDouble {
                tokenStarted = true
                inSingle.toggle()
                continue
            }

            if ch == "\"", !inSingle {
                tokenStarted = true
                inDouble.toggle()
                continue
            }

            if isShellWordSeparator(ch), !inSingle, !inDouble {
                appendCurrent()
                continue
            }

            current.append(ch)
            tokenStarted = true
        }

        if escaped {
            current.append("\\")
        }
        appendCurrent()
        return tokens
    }

    private static func isShellWordSeparator(_ ch: Character) -> Bool {
        ch == " " || ch == "\t" || ch == "\n"
    }

    private static func trimmingShellWordSeparators(_ value: String) -> String {
        var start = value.startIndex
        while start < value.endIndex, isShellWordSeparator(value[start]) {
            value.formIndex(after: &start)
        }
        var end = value.endIndex
        while end > start {
            let previous = value.index(before: end)
            guard isShellWordSeparator(value[previous]) else { break }
            end = previous
        }
        return String(value[start ..< end])
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
        let trimmed = trimmingShellWordSeparators(command)
        guard !trimmed.isEmpty else { return nil }

        var segments: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false
        let chars = Array(trimmed)
        var idx = 0

        func appendCurrent() -> Bool {
            let segment = trimmingShellWordSeparators(current)
            guard !segment.isEmpty else { return false }
            segments.append(segment)
            current.removeAll(keepingCapacity: true)
            return true
        }

        while idx < chars.count {
            let ch = chars[idx]
            let next: Character? = idx + 1 < chars.count ? chars[idx + 1] : nil
            let lookahead = nextShellSignificantCharacter(chars: chars, after: idx, inSingle: inSingle)

            if escaped {
                if ch == "\n" {
                    escaped = false
                    idx += 1
                    continue
                }
                current.append(ch)
                escaped = false
                idx += 1
                continue
            }

            if ch == "\\", !inSingle {
                if next == "\n" {
                    idx += 2
                    continue
                }
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

            if !inSingle, shouldFailClosedForShell(ch: ch, next: lookahead, inDouble: inDouble) {
                // Fail closed on command/process substitution in allowlist mode,
                // including command substitution inside double-quoted shell strings.
                return nil
            }

            if !inSingle, !inDouble {
                let prev: Character? = idx > 0 ? chars[idx - 1] : nil
                if let delimiterStep = chainDelimiterStep(ch: ch, prev: prev, next: next) {
                    guard appendCurrent() else { return nil }
                    idx += delimiterStep
                    continue
                }
            }

            current.append(ch)
            idx += 1
        }

        if escaped || inSingle || inDouble {
            return nil
        }
        guard appendCurrent() else { return nil }
        return segments
    }

    private static func nextShellSignificantCharacter(
        chars: [Character],
        after idx: Int,
        inSingle: Bool
    ) -> Character? {
        guard !inSingle else {
            return idx + 1 < chars.count ? chars[idx + 1] : nil
        }
        var cursor = idx + 1
        while cursor < chars.count {
            if chars[cursor] == "\\", cursor + 1 < chars.count, chars[cursor + 1] == "\n" {
                cursor += 2
                continue
            }
            return chars[cursor]
        }
        return nil
    }

    private static func shouldFailClosedForShell(ch: Character, next: Character?, inDouble: Bool) -> Bool {
        let context: ShellTokenContext = inDouble ? .doubleQuoted : .unquoted
        guard let rules = shellFailClosedRules[context] else {
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
            if !needsQuotes {
                return trimmed
            }
            let escaped = trimmed.replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        }.joined(separator: " ")
    }

    static func displayString(for argv: [String], rawCommand: String?) -> String {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            return trimmed
        }
        return displayString(for: argv)
    }
}
