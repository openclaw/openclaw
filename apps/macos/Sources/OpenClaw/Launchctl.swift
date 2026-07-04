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
    private static let envWrapperShell = "/bin/sh"

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
        let rawProgramArguments = root["ProgramArguments"] as? [String] ?? []
        let inlineEnv = root["EnvironmentVariables"] as? [String: String] ?? [:]
        let fileEnv = Self.readGeneratedEnvironmentFile(programArguments: rawProgramArguments)
        let env = inlineEnv.merging(fileEnv) { _, file in file }
        let programArguments = Self.unwrapGeneratedEnvWrapperArgs(rawProgramArguments)
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

    private static func unwrapGeneratedEnvWrapperArgs(_ programArguments: [String]) -> [String] {
        guard let layout = Self.resolveGeneratedEnvWrapperLayout(programArguments) else {
            return programArguments
        }
        return Array(programArguments.dropFirst(layout.commandStartIndex))
    }

    private static func readGeneratedEnvironmentFile(programArguments: [String]) -> [String: String] {
        guard let layout = Self.resolveGeneratedEnvWrapperLayout(programArguments) else {
            return [:]
        }
        guard let content = try? String(contentsOf: URL(fileURLWithPath: layout.envFilePath), encoding: .utf8) else {
            return [:]
        }
        var environment: [String: String] = [:]
        for rawLine in content.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") {
                continue
            }
            guard line.hasPrefix("export ") else { continue }
            let payload = String(line.dropFirst("export ".count))
            guard let equalIndex = payload.firstIndex(of: "=") else { continue }
            let key = String(payload[..<equalIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = key.first, first.isLetter || first == "_" else { continue }
            guard key.dropFirst().allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { continue }
            let valueStart = payload.index(after: equalIndex)
            let rawValue = String(payload[valueStart...])
            environment[key] = Self.parseGeneratedEnvValue(rawValue)
        }
        return environment
    }

    private static func parseGeneratedEnvValue(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("'"), trimmed.hasSuffix("'"), trimmed.count >= 2 else {
            return trimmed
        }
        let inner = trimmed.dropFirst().dropLast()
        return inner.replacingOccurrences(of: "'\\''", with: "'")
    }

    private struct GeneratedEnvWrapperLayout {
        let envFilePath: String
        let commandStartIndex: Int
    }

    private static func resolveGeneratedEnvWrapperLayout(
        _ programArguments: [String]) -> GeneratedEnvWrapperLayout?
    {
        if programArguments.first == Self.envWrapperShell,
           programArguments.count >= 3,
           Self.isExpectedGeneratedEnvWrapperPair(
               wrapperPath: programArguments[1],
               envFilePath: programArguments[2])
        {
            return GeneratedEnvWrapperLayout(envFilePath: programArguments[2], commandStartIndex: 3)
        }
        if programArguments.count >= 2,
           Self.isExpectedGeneratedEnvWrapperPair(
               wrapperPath: programArguments[0],
               envFilePath: programArguments[1])
        {
            return GeneratedEnvWrapperLayout(envFilePath: programArguments[1], commandStartIndex: 2)
        }
        return nil
    }

    private static func isExpectedGeneratedEnvWrapperPair(
        wrapperPath: String,
        envFilePath: String) -> Bool
    {
        guard !wrapperPath.isEmpty, !envFilePath.isEmpty else { return false }
        return wrapperPath.hasSuffix("-env-wrapper.sh")
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
