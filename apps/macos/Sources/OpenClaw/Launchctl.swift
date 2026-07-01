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
        let stdoutPath = (root["StandardOutPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let stderrPath = (root["StandardErrorPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let port = Self.extractFlagInt(programArguments, flag: "--port")
        let bind = Self.extractFlagString(programArguments, flag: "--bind")?.lowercased()
        let token = env["OPENCLAW_GATEWAY_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let password = env["OPENCLAW_GATEWAY_PASSWORD"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        return LaunchAgentPlistSnapshot(
            programArguments: programArguments,
            environment: env,
            stdoutPath: stdoutPath,
            stderrPath: stderrPath,
            port: port,
            bind: bind,
            token: token,
            password: password)
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

    private static func readGeneratedEnvironmentFile(_ programArguments: [String]) -> [String: String] {
        guard Self.isGeneratedEnvironmentWrapperArgs(programArguments) else { return [:] }
        let envFilePath = programArguments[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !envFilePath.isEmpty else { return [:] }
        guard let content = try? String(contentsOf: URL(fileURLWithPath: envFilePath), encoding: .utf8) else {
            return [:]
        }
        var environment: [String: String] = [:]
        for rawLine in content.components(separatedBy: .newlines) {
            guard let (key, value) = Self.parseGeneratedEnvironmentLine(rawLine) else { continue }
            environment[key] = value
        }
        return environment
    }

    private static func isGeneratedEnvironmentWrapperArgs(_ programArguments: [String]) -> Bool {
        guard programArguments.count >= 2 else { return false }
        let wrapperPath = programArguments[0].trimmingCharacters(in: .whitespacesAndNewlines)
        let envFilePath = programArguments[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return wrapperPath.hasSuffix("-env-wrapper.sh") && !envFilePath.isEmpty
    }

    private static func parseGeneratedEnvironmentLine(_ rawLine: String) -> (String, String)? {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !line.hasPrefix("#"), line.hasPrefix("export ") else { return nil }
        let assignment = line.dropFirst("export ".count)
        guard let separator = assignment.firstIndex(of: "=") else { return nil }
        let key = String(assignment[..<separator])
        guard Self.isValidEnvironmentKey(key) else { return nil }
        let rawValue = String(assignment[assignment.index(after: separator)...])
        return (key, Self.parseGeneratedEnvironmentValue(rawValue))
    }

    private static func parseGeneratedEnvironmentValue(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("'"), trimmed.hasSuffix("'"), trimmed.count >= 2 else {
            return trimmed
        }
        let inner = String(trimmed.dropFirst().dropLast())
        return inner.replacingOccurrences(of: "'\\''", with: "'")
    }

    private static func isValidEnvironmentKey(_ key: String) -> Bool {
        guard let first = key.unicodeScalars.first, Self.isEnvironmentKeyFirstScalar(first) else {
            return false
        }
        return key.unicodeScalars.dropFirst().allSatisfy { Self.isEnvironmentKeyScalar($0) }
    }

    private static func isEnvironmentKeyFirstScalar(_ scalar: UnicodeScalar) -> Bool {
        scalar == "_" || (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122)
    }

    private static func isEnvironmentKeyScalar(_ scalar: UnicodeScalar) -> Bool {
        Self.isEnvironmentKeyFirstScalar(scalar) || (scalar.value >= 48 && scalar.value <= 57)
    }
}
