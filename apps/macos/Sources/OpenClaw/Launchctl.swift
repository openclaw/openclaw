import Foundation

enum Launchctl {
    struct Result {
        let status: Int32
        let output: String
    }

    @discardableResult
    static func run(_ args: [String]) async -> Result {
        await Task.detached(priority: .utility) { () -> Result in
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                let data = try process.runAndReadToEnd(from: pipe)
                let output = String(data: data, encoding: .utf8) ?? ""
                return Result(status: process.terminationStatus, output: output)
            } catch {
                return Result(status: -1, output: error.localizedDescription)
            }
        }.value
    }
}

struct LaunchAgentPlistSnapshot: Equatable {
    let programArguments: [String]
    let environment: [String: String]
    let stdoutPath: String?
    let stderrPath: String?

    let port: Int?
    let bind: String?
    let token: String?
    let password: String?
}

enum LaunchAgentPlist {
    static func snapshot(url: URL) -> LaunchAgentPlistSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let rootAny: Any
        do {
            rootAny = try PropertyListSerialization.propertyList(
                from: data,
                options: [],
                format: nil)
        } catch {
            return nil
        }
        guard let root = rootAny as? [String: Any] else { return nil }
        let programArguments = root["ProgramArguments"] as? [String] ?? []
        let inlineEnv = root["EnvironmentVariables"] as? [String: String] ?? [:]
        let fileEnv = Self.readGeneratedEnvironmentFile(programArguments)
        let env = inlineEnv.merging(fileEnv) { _, fileValue in fileValue }
        let effectiveProgramArguments = Self.unwrapGeneratedEnvironmentWrapper(programArguments)
        let stdoutPath = (root["StandardOutPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let stderrPath = (root["StandardErrorPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let port = Self.extractFlagInt(effectiveProgramArguments, flag: "--port")
        let bind = Self.extractFlagString(effectiveProgramArguments, flag: "--bind")?.lowercased()
        let token = env["OPENCLAW_GATEWAY_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let password = env["OPENCLAW_GATEWAY_PASSWORD"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        return LaunchAgentPlistSnapshot(
            programArguments: effectiveProgramArguments,
            environment: env,
            stdoutPath: stdoutPath,
            stderrPath: stderrPath,
            port: port,
            bind: bind,
            token: token,
            password: password)
    }

    private static func isGeneratedEnvironmentWrapper(_ args: [String]) -> Bool {
        guard args.count >= 2 else { return false }
        let wrapperPath = args[0]
        let envFilePath = args[1]
        guard !wrapperPath.isEmpty, !envFilePath.isEmpty else { return false }
        if wrapperPath.hasSuffix("-env-wrapper.sh") {
            return true
        }
        let normalizedWrapperPath = wrapperPath.replacingOccurrences(of: "\\", with: "/")
        let normalizedEnvFilePath = envFilePath.replacingOccurrences(of: "\\", with: "/")
        return normalizedWrapperPath.contains("/service-env/") &&
            normalizedEnvFilePath.contains("/service-env/")
    }

    private static func readGeneratedEnvironmentFile(_ args: [String]) -> [String: String] {
        guard Self.isGeneratedEnvironmentWrapper(args) else { return [:] }
        guard args.count >= 2 else { return [:] }
        guard let content = try? String(contentsOfFile: args[1], encoding: .utf8) else { return [:] }
        var environment: [String: String] = [:]
        for rawLine in content.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") {
                continue
            }
            guard line.hasPrefix("export ") else { continue }
            let assignment = line.dropFirst("export ".count)
            guard let equalsIndex = assignment.firstIndex(of: "=") else { continue }
            let key = String(assignment[..<equalsIndex])
            guard Self.isValidEnvironmentKey(key) else { continue }
            let value = String(assignment[assignment.index(after: equalsIndex)...])
            environment[key] = Self.parseGeneratedEnvironmentValue(value)
        }
        return environment
    }

    private static func isValidEnvironmentKey(_ key: String) -> Bool {
        guard let first = key.unicodeScalars.first else { return false }
        guard first == "_" || CharacterSet.letters.contains(first) else { return false }
        return key.unicodeScalars.allSatisfy { scalar in
            scalar == "_" || CharacterSet.alphanumerics.contains(scalar)
        }
    }

    private static func parseGeneratedEnvironmentValue(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("'"), trimmed.hasSuffix("'"), trimmed.count >= 2 else {
            return trimmed
        }
        let innerStart = trimmed.index(after: trimmed.startIndex)
        let innerEnd = trimmed.index(before: trimmed.endIndex)
        return String(trimmed[innerStart..<innerEnd]).replacingOccurrences(of: "'\\''", with: "'")
    }

    private static func unwrapGeneratedEnvironmentWrapper(_ args: [String]) -> [String] {
        guard Self.isGeneratedEnvironmentWrapper(args) else { return args }
        return Array(args.dropFirst(2))
    }

    private static func extractFlagInt(_ args: [String], flag: String) -> Int? {
        guard let raw = self.extractFlagString(args, flag: flag) else { return nil }
        return Int(raw)
    }

    private static func extractFlagString(_ args: [String], flag: String) -> String? {
        guard let idx = args.firstIndex(of: flag) else { return nil }
        let valueIdx = args.index(after: idx)
        guard valueIdx < args.endIndex else { return nil }
        let token = args[valueIdx].trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }
}
