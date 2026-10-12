import Foundation
import OSLog

struct RuntimeResolution {
    let path: String
    let version: Semver
}

enum RuntimeResolutionError: Error {
    case notFound(searchPaths: [String])
    case unsupported(
        found: Semver,
        path: String,
        searchPaths: [String])
    case versionParse(raw: String, path: String, searchPaths: [String])
}

enum RuntimeLocator {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "runtime")
    // Keep these floors aligned with package.json engines so the app never launches
    // the gateway on an unsupported odd release or an older even-major runtime.
    private static let minNode24 = Semver(major: 24, minor: 16, patch: 0)
    private static let minNode26 = Semver(major: 26, minor: 1, patch: 0)
    private static let supportedNodeRange = ">=24.16.0 <25, or >=26.1.0"

    static func parseVersion(_ output: String) -> Semver? {
        // Node probes and manager directory names may include a prefix or trailing metadata.
        guard let match = output.range(of: #"(\d+)\.(\d+)\.(\d+)"#, options: .regularExpression) else { return nil }
        return Semver.parse(String(output[match]))
    }

    static func isSupportedNodeVersion(_ version: Semver) -> Bool {
        (version.major == self.minNode24.major && version >= self.minNode24) || version >= self.minNode26
    }

    static func resolve(
        searchPaths: [String] = CommandResolver.preferredPaths()) async
        -> Result<RuntimeResolution, RuntimeResolutionError>
    {
        let pathEnv = searchPaths.joined(separator: ":")
        guard let binary = CommandResolver.findExecutable(named: "node", searchPaths: searchPaths) else {
            return .failure(.notFound(searchPaths: searchPaths))
        }
        guard let rawVersion = await ExecutableVersionProbe.read(
            binary: binary,
            pathEnv: pathEnv,
            logger: self.logger,
            label: "runtime")?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return .failure(.versionParse(
                raw: "(unreadable)",
                path: binary,
                searchPaths: searchPaths))
        }
        guard let parsed = self.parseVersion(rawVersion) else {
            return .failure(.versionParse(raw: rawVersion, path: binary, searchPaths: searchPaths))
        }
        guard self.isSupportedNodeVersion(parsed) else {
            return .failure(.unsupported(
                found: parsed,
                path: binary,
                searchPaths: searchPaths))
        }

        return .success(RuntimeResolution(path: binary, version: parsed))
    }

    static func describeFailure(_ error: RuntimeResolutionError) -> String {
        switch error {
        case let .notFound(searchPaths):
            [
                "openclaw needs Node \(self.supportedNodeRange) but found no runtime.",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Install Node: https://nodejs.org/en/download",
            ].joined(separator: "\n")
        case let .unsupported(found, path, searchPaths):
            [
                "Found node \(found) at \(path) but need \(self.supportedNodeRange).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Upgrade Node and rerun openclaw.",
            ].joined(separator: "\n")
        case let .versionParse(raw, path, searchPaths):
            [
                "Could not parse node version output \"\(raw)\" from \(path).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Try reinstalling or pinning a supported version (Node \(self.supportedNodeRange)).",
            ].joined(separator: "\n")
        }
    }
}

enum ExecutableVersionProbe {
    static func read(binary: String, pathEnv: String, logger: Logger, label: String) async -> String? {
        let start = Date()
        do {
            let result = try await BoundedProcess.run(
                path: binary,
                arguments: ["--version"],
                environment: ["PATH": pathEnv],
                timeout: CommandResolver.versionProbeTimeout)
            guard result.terminationStatus == 0 else { return nil }
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                logger.warning(
                    """
                    \(label, privacy: .public) --version slow (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            } else {
                logger.debug(
                    """
                    \(label, privacy: .public) --version ok (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            }
            return String(data: result.output, encoding: .utf8)
        } catch {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            logger.error(
                """
                \(label, privacy: .public) --version failed (\(elapsedMs, privacy: .public)ms) \
                bin=\(binary, privacy: .public) \
                err=\(error.localizedDescription, privacy: .public)
                """)
            return nil
        }
    }
}
