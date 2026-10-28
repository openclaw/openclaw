import Foundation
import Synchronization

struct LaunchAgentPlistSnapshot: Equatable, Sendable {
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
    static var homeDirectoryURL: URL {
        #if DEBUG
        if let testingHomeDirectoryURL { return testingHomeDirectoryURL }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser
    }

    #if DEBUG
    // UI callbacks can outlive the test task's executor context. TestIsolation
    // owns this override without redirecting Foundation's process-wide home.
    private static let testingHomeDirectory = Mutex<URL?>(nil)
    static var testingHomeDirectoryURL: URL? {
        get { self.testingHomeDirectory.withLock { $0 } }
        set { self.testingHomeDirectory.withLock { $0 = newValue } }
    }
    #endif

    static func snapshot(
        url: URL,
        generatedEnvironmentFileURL: URL? = nil,
        generatedEnvironmentWrapperURL: URL? = nil) -> LaunchAgentPlistSnapshot?
    {
        guard let data = try? Data(contentsOf: url),
              let root = try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil) as? [String: Any]
        else { return nil }
        let programArguments = root["ProgramArguments"] as? [String] ?? []
        let inlineEnvironment = root["EnvironmentVariables"] as? [String: String] ?? [:]
        let generatedEnvironment = self.readGeneratedEnvironment(
            programArguments: programArguments,
            fileURL: generatedEnvironmentFileURL,
            wrapperURL: generatedEnvironmentWrapperURL)
        let env = inlineEnvironment.merging(generatedEnvironment) { _, generated in generated }
        let stdoutPath = (root["StandardOutPath"] as? String)?.nonEmpty
        let stderrPath = (root["StandardErrorPath"] as? String)?.nonEmpty
        let port = Self.extractFlagString(programArguments, flag: "--port").flatMap(Int.init)
        let bind = Self.extractFlagString(programArguments, flag: "--bind")?.lowercased()
        let token = env["OPENCLAW_GATEWAY_TOKEN"]?.nonEmpty
        let password = env["OPENCLAW_GATEWAY_PASSWORD"]?.nonEmpty
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

    static func readGeneratedEnvironment(
        programArguments: [String],
        fileURL: URL?,
        wrapperURL: URL?) -> [String: String]
    {
        guard let fileURL, let wrapperURL else { return [:] }
        let filePath = fileURL.standardizedFileURL.path
        let wrapperPath = wrapperURL.standardizedFileURL.path
        let usesShellWrapper = programArguments.count >= 3 &&
            programArguments[0] == "/bin/sh" &&
            programArguments[1] == wrapperPath &&
            programArguments[2] == filePath
        let usesDirectWrapper = programArguments.count >= 2 &&
            programArguments[0] == wrapperPath &&
            programArguments[1] == filePath
        // Read only the canonical file when the LaunchAgent uses OpenClaw's generated wrapper.
        // This keeps arbitrary ProgramArguments paths from becoming app-readable secret sources.
        guard usesShellWrapper || usesDirectWrapper,
              FileManager.default.fileExists(atPath: wrapperPath),
              let content = try? String(contentsOf: fileURL, encoding: .utf8)
        else { return [:] }

        return (try? self.parseGeneratedEnvironment(content)) ?? [:]
    }

    static func parseGeneratedEnvironment(_ content: String) throws -> [String: String] {
        // Core emits literal single-quoted exports; values can span lines and use '\'' for apostrophes.
        let pattern = #"(?m)^[\t ]*export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'[\t ]*(?:\r?\n|$)"#
        let regex = try NSRegularExpression(pattern: pattern)
        let source = content as NSString
        let matches = regex.matches(in: content, range: NSRange(location: 0, length: source.length))
        var environment: [String: String] = [:]
        var offset = 0
        func isCommentOrWhitespace(_ range: NSRange) -> Bool {
            source.substring(with: range).components(separatedBy: .newlines).allSatisfy {
                let line = $0.trimmingCharacters(in: .whitespaces)
                return line.isEmpty || line.hasPrefix("#")
            }
        }
        for match in matches {
            guard isCommentOrWhitespace(NSRange(location: offset, length: match.range.location - offset)) else {
                throw GatewayHostingError(message: "The retained Gateway environment has unsupported syntax.")
            }
            let key = source.substring(with: match.range(at: 1))
            environment[key] = source.substring(with: match.range(at: 2))
                .replacingOccurrences(of: #"'\''"#, with: "'")
            offset = NSMaxRange(match.range)
        }
        guard isCommentOrWhitespace(NSRange(location: offset, length: source.length - offset)) else {
            throw GatewayHostingError(message: "The retained Gateway environment has unsupported syntax.")
        }
        return environment
    }

    private static func extractFlagString(_ args: [String], flag: String) -> String? {
        guard let idx = args.firstIndex(of: flag) else { return nil }
        let valueIdx = args.index(after: idx)
        guard valueIdx < args.endIndex else { return nil }
        return args[valueIdx].nonEmpty
    }
}
