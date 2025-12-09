import ClawdisIPC
import Foundation

// Lightweight SemVer helper (major.minor.patch only) for relay compatibility checks.
struct Semver: Comparable, CustomStringConvertible, Sendable {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String { "\(self.major).\(self.minor).\(self.patch)" }

    static func < (lhs: Semver, rhs: Semver) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }

    static func parse(_ raw: String?) -> Semver? {
        guard let raw, !raw.isEmpty else { return nil }
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^v", with: "", options: .regularExpression)
        let parts = cleaned.split(separator: ".")
        guard parts.count >= 3,
              let major = Int(parts[0]),
              let minor = Int(parts[1])
        else { return nil }
        let patch = Int(parts[2]) ?? 0
        return Semver(major: major, minor: minor, patch: patch)
    }

    func compatible(with required: Semver) -> Bool {
        // Same major and not older than required.
        self.major == required.major && self >= required
    }
}

enum RelayEnvironmentKind: Equatable {
    case checking
    case ok
    case missingNode
    case missingRelay
    case incompatible(found: String, required: String)
    case error(String)
}

struct RelayEnvironmentStatus: Equatable {
    let kind: RelayEnvironmentKind
    let nodeVersion: String?
    let relayVersion: String?
    let requiredRelay: String?
    let message: String

    static var checking: Self {
        .init(kind: .checking, nodeVersion: nil, relayVersion: nil, requiredRelay: nil, message: "Checking…")
    }
}

struct RelayCommandResolution {
    let status: RelayEnvironmentStatus
    let command: [String]?
}

enum RelayEnvironment {
    static func gatewayPort() -> Int {
        let stored = UserDefaults.standard.integer(forKey: "gatewayPort")
        return stored > 0 ? stored : 18789
    }

    static func expectedRelayVersion() -> Semver? {
        let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return Semver.parse(bundleVersion)
    }

    static func check() -> RelayEnvironmentStatus {
        let expected = self.expectedRelayVersion()

        switch RuntimeLocator.resolve(searchPaths: CommandResolver.preferredPaths()) {
        case let .failure(err):
            return RelayEnvironmentStatus(
                kind: .missingNode,
                nodeVersion: nil,
                relayVersion: nil,
                requiredRelay: expected?.description,
                message: RuntimeLocator.describeFailure(err))
        case let .success(runtime):
            guard let relayBin = CommandResolver.clawdisExecutable() else {
                return RelayEnvironmentStatus(
                    kind: .missingRelay,
                    nodeVersion: runtime.version.description,
                    relayVersion: nil,
                    requiredRelay: expected?.description,
                    message: "clawdis CLI not found in PATH; install the global package.")
            }

            let installedRelay = self.readRelayVersion(binary: relayBin)
            if let expected, let installed = installedRelay, !installed.compatible(with: expected) {
                return RelayEnvironmentStatus(
                    kind: .incompatible(found: installed.description, required: expected.description),
                    nodeVersion: runtime.version.description,
                    relayVersion: installed.description,
                    requiredRelay: expected.description,
                    message: "Relay version \(installed.description) is incompatible with app \(expected.description); install/update the global package.")
            }

            return RelayEnvironmentStatus(
                kind: .ok,
                nodeVersion: runtime.version.description,
                relayVersion: installedRelay?.description,
                requiredRelay: expected?.description,
                message: "Node \(runtime.version.description); relay \(installedRelay?.description ?? "unknown")")
        }
    }

    static func resolveGatewayCommand() -> RelayCommandResolution {
        let status = self.check()
        guard case .ok = status.kind, let relayBin = CommandResolver.clawdisExecutable() else {
            return RelayCommandResolution(status: status, command: nil)
        }

        let port = self.gatewayPort()
        let cmd = [relayBin, "gateway", "--port", "\(port)"]
        return RelayCommandResolution(status: status, command: cmd)
    }

    static func installGlobal(version: Semver?, statusHandler: @escaping @Sendable (String) -> Void) async {
        let preferred = CommandResolver.preferredPaths().joined(separator: ":")
        let target = version?.description ?? "latest"
        let pnpm = CommandResolver.findExecutable(named: "pnpm") ?? "pnpm"
        let cmd = [pnpm, "add", "-g", "clawdis@\(target)"]

        statusHandler("Installing clawdis@\(target) via pnpm…")
        let response = await ShellExecutor.run(command: cmd, cwd: nil, env: ["PATH": preferred], timeout: 300)
        if response.ok {
            statusHandler("Installed clawdis@\(target)")
        } else {
            let detail = response.message ?? "install failed"
            statusHandler("Install failed: \(detail)")
        }
    }

    // MARK: - Internals

    private static func readRelayVersion(binary: String) -> Semver? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["--version"]
        process.environment = ["PATH": CommandResolver.preferredPaths().joined(separator: ":")]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return Semver.parse(raw)
        } catch {
            return nil
        }
    }
}
