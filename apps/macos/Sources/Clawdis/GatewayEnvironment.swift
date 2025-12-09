import ClawdisIPC
import Foundation

// Lightweight SemVer helper (major.minor.patch only) for gateway compatibility checks.
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

enum GatewayEnvironmentKind: Equatable {
    case checking
    case ok
    case missingNode
    case missingGateway
    case incompatible(found: String, required: String)
    case error(String)
}

struct GatewayEnvironmentStatus: Equatable {
    let kind: GatewayEnvironmentKind
    let nodeVersion: String?
    let gatewayVersion: String?
    let requiredGateway: String?
    let message: String

    static var checking: Self {
        .init(kind: .checking, nodeVersion: nil, gatewayVersion: nil, requiredGateway: nil, message: "Checking…")
    }
}

struct GatewayCommandResolution {
    let status: GatewayEnvironmentStatus
    let command: [String]?
}

enum GatewayEnvironment {
    static func gatewayPort() -> Int {
        let stored = UserDefaults.standard.integer(forKey: "gatewayPort")
        return stored > 0 ? stored : 18789
    }

    static func expectedGatewayVersion() -> Semver? {
        let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return Semver.parse(bundleVersion)
    }

    static func check() -> GatewayEnvironmentStatus {
        let expected = self.expectedGatewayVersion()
        let projectRoot = CommandResolver.projectRoot()
        let projectEntrypoint = CommandResolver.gatewayEntrypoint(in: projectRoot)

        switch RuntimeLocator.resolve(searchPaths: CommandResolver.preferredPaths()) {
        case let .failure(err):
            return GatewayEnvironmentStatus(
                kind: .missingNode,
                nodeVersion: nil,
                gatewayVersion: nil,
                requiredGateway: expected?.description,
                message: RuntimeLocator.describeFailure(err))
        case let .success(runtime):
            let gatewayBin = CommandResolver.clawdisExecutable()

            if gatewayBin == nil, projectEntrypoint == nil {
                return GatewayEnvironmentStatus(
                    kind: .missingGateway,
                    nodeVersion: runtime.version.description,
                    gatewayVersion: nil,
                    requiredGateway: expected?.description,
                    message: "clawdis CLI not found in PATH; install the global package.")
            }

            let installed = gatewayBin.flatMap { self.readGatewayVersion(binary: $0) }
                ?? self.readLocalGatewayVersion(projectRoot: projectRoot)

            if let expected, let installed, !installed.compatible(with: expected) {
                return GatewayEnvironmentStatus(
                    kind: .incompatible(found: installed.description, required: expected.description),
                    nodeVersion: runtime.version.description,
                    gatewayVersion: installed.description,
                    requiredGateway: expected.description,
                    message: "Gateway version \(installed.description) is incompatible with app \(expected.description); install/update the global package.")
            }

            let gatewayLabel = gatewayBin != nil ? "global" : "local"
            let gatewayVersionText = installed?.description ?? "unknown"
            let localPathHint = gatewayBin == nil && projectEntrypoint != nil
                ? " (local: \(projectEntrypoint?.path ?? "unknown"))"
                : ""
            return GatewayEnvironmentStatus(
                kind: .ok,
                nodeVersion: runtime.version.description,
                gatewayVersion: gatewayVersionText,
                requiredGateway: expected?.description,
                message: "Node \(runtime.version.description); gateway \(gatewayVersionText) (\(gatewayLabel))\(localPathHint)")
        }
    }

    static func resolveGatewayCommand() -> GatewayCommandResolution {
        let projectRoot = CommandResolver.projectRoot()
        let projectEntrypoint = CommandResolver.gatewayEntrypoint(in: projectRoot)
        let status = self.check()
        let gatewayBin = CommandResolver.clawdisExecutable()
        let runtime = RuntimeLocator.resolve(searchPaths: CommandResolver.preferredPaths())

        guard case .ok = status.kind else {
            return GatewayCommandResolution(status: status, command: nil)
        }

        let port = self.gatewayPort()
        if let gatewayBin {
            let cmd = [gatewayBin, "gateway", "--port", "\(port)"]
            return GatewayCommandResolution(status: status, command: cmd)
        }

        if let entry = projectEntrypoint,
           case let .success(resolvedRuntime) = runtime
        {
            let cmd = [resolvedRuntime.path, entry, "gateway", "--port", "\(port)"]
            return GatewayCommandResolution(status: status, command: cmd)
        }

        return GatewayCommandResolution(status: status, command: nil)
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

    private static func readGatewayVersion(binary: String) -> Semver? {
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

    private static func readLocalGatewayVersion(projectRoot: URL) -> Semver? {
        let pkg = projectRoot.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: pkg) else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = json["version"] as? String
        else { return nil }
        return Semver.parse(version)
    }
}
