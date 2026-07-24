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
        let rawProgramArguments = root["ProgramArguments"] as? [String] ?? []
        let inlineEnv = root["EnvironmentVariables"] as? [String: String] ?? [:]
        let fileEnv = Self.readGeneratedEnvironmentFile(programArguments: rawProgramArguments)
        let env = inlineEnv.merging(fileEnv) { _, fileValue in fileValue }
        let programArguments = Self.unwrapGeneratedEnvironmentWrapperArgs(rawProgramArguments)
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

    private static func unwrapGeneratedEnvironmentWrapperArgs(_ args: [String]) -> [String] {
        guard self.isGeneratedEnvironmentWrapperArgs(args) else { return args }
        return Array(args.dropFirst(2))
    }

    private static func isGeneratedEnvironmentWrapperArgs(_ args: [String]) -> Bool {
        guard let wrapperPath = args.first, args.count >= 2 else { return false }
        let wrapperURL = URL(fileURLWithPath: wrapperPath)
        let envFileURL = URL(fileURLWithPath: args[1])
        let wrapperDirURL = wrapperURL.deletingLastPathComponent()
        let envFileDirURL = envFileURL.deletingLastPathComponent()
        guard wrapperDirURL.lastPathComponent == "service-env",
              wrapperDirURL.path == envFileDirURL.path
        else { return false }
        let wrapperName = wrapperURL.lastPathComponent
        let suffix = "-env-wrapper.sh"
        guard wrapperName.hasSuffix(suffix) else { return false }
        let label = String(wrapperName.dropLast(suffix.count))
        return !label.isEmpty && envFileURL.lastPathComponent == "\(label).env"
    }

    private static func readGeneratedEnvironmentFile(programArguments: [String]) -> [String: String] {
        guard self.isGeneratedEnvironmentWrapperArgs(programArguments),
              programArguments.indices.contains(1)
        else { return [:] }
        let envFileURL = URL(fileURLWithPath: programArguments[1])
        guard let content = try? String(contentsOf: envFileURL, encoding: .utf8) else {
            return [:]
        }
        var environment: [String: String] = [:]
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#"), line.hasPrefix("export ") else {
                continue
            }
            let assignment = line.dropFirst("export ".count)
            guard let equalsIndex = assignment.firstIndex(of: "=") else { continue }
            let key = String(assignment[..<equalsIndex])
            guard self.isEnvironmentKey(key) else { continue }
            let value = String(assignment[assignment.index(after: equalsIndex)...])
            environment[key] = self.parseGeneratedEnvironmentValue(value)
        }
        return environment
    }

    private static func isEnvironmentKey(_ key: String) -> Bool {
        guard let first = key.unicodeScalars.first,
              first == "_" || CharacterSet.letters.contains(first)
        else { return false }
        return key.unicodeScalars.allSatisfy {
            $0 == "_" || CharacterSet.alphanumerics.contains($0)
        }
    }

    private static func parseGeneratedEnvironmentValue(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("'"), trimmed.hasSuffix("'") else { return trimmed }
        return String(trimmed.dropFirst().dropLast())
            .replacingOccurrences(of: "'\\''", with: "'")
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
