import Foundation
import OpenClawKit

/// The signed bundle owns the payload; the profile's seeded copy hosts its CLI and Gateway.
struct BundledRuntime: Sendable {
    let root: URL
    let bun: URL
    let packageRoot: URL
    let sqliteLibrary: URL

    static var isBundledApp: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    var cliCommand: [String] {
        [self.bun.path, self.packageRoot.appendingPathComponent("openclaw.mjs").path]
    }

    var environment: [String: String] {
        [
            "PATH": self.bun.deletingLastPathComponent().path,
            "OPENCLAW_SQLITE_LIBRARY": self.sqliteLibrary.path,
        ]
    }

    struct BuildInfo: Decodable, Equatable, Sendable {
        let version: String
        let commit: String
        let builtAt: String
        let buildId: String
    }

    static func launch(
        bundle: Bundle,
        profile: AppProfile = .current,
        desktopSharingEnabled: Bool? = nil) throws -> MacNodeHostWorkerLaunch
    {
        let runtime = try resolve(bundle: bundle)
        return try MacNodeHostWorkerLaunch(
            command: CommandResolver.nodeHostWorkerCommand(
                prefix: runtime.command(entry: "mac-node-worker.js"),
                profile: profile,
                desktopSharingEnabled: desktopSharingEnabled),
            currentDirectoryURL: runtime.packageRoot,
            environment: runtime.environment)
    }

    /// Browser setup needs the same host-local runtime as the node, including on a remote-only Mac.
    /// Keep this fixed operation separate from the external CLI/Gateway resolver.
    static func browserSetupLaunch(
        bundle: Bundle,
        action: ChromeExtensionSetupAction = .install,
        profile: AppProfile = .current) throws -> MacNodeHostWorkerLaunch
    {
        let runtime = try resolve(bundle: bundle)
        var environment = runtime.environment
        environment["OPENCLAW_PROFILE"] = profile.name ?? "default"
        return try MacNodeHostWorkerLaunch(
            command: runtime.command(entry: "extensions/browser/setup-entry.js") + [
                "--action", action.rawValue, "--wait-ms", "1000",
            ],
            currentDirectoryURL: runtime.packageRoot,
            environment: environment)
    }

    static func resolve(bundle: Bundle) throws -> Self {
        let root = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime")
        return try self.resolve(root: root, bundle: bundle)
    }

    static func resolve(root: URL, bundle: Bundle) throws -> Self {
        let runtime = Self(root: root)
        let info = bundle.infoDictionary ?? [:]
        let appBuild = ArtifactBuildInfo(infoDictionary: info)
        do {
            let build = try JSONDecoder().decode(
                BuildInfo.self,
                from: Data(contentsOf: runtime.packageRoot.appendingPathComponent("dist/build-info.json")))
            guard build.version == appBuild.version,
                  build.commit == appBuild.gitCommit,
                  build.builtAt == appBuild.buildTimestamp,
                  build.buildId == info["OpenClawRuntimeBuildID"] as? String,
                  FileManager.default.isExecutableFile(atPath: runtime.bun.path),
                  FileManager.default.isReadableFile(atPath: runtime.sqliteLibrary.path)
            else {
                throw MacNodeHostWorker.WorkerError.unavailable(reason: "Private runtime build does not match this app")
            }
        } catch {
            throw MacNodeHostWorker.WorkerError.unavailable(
                reason: "The bundled runtime is missing or incompatible. Rebuild or reinstall OpenClaw.app.",
                diagnostic: error.localizedDescription)
        }
        return runtime
    }

    init(root: URL) {
        self.root = root
        self.bun = root.appendingPathComponent("bin/bun")
        self.packageRoot = root.appendingPathComponent("lib/node_modules/openclaw")
        self.sqliteLibrary = root.appendingPathComponent("lib/libsqlite3.dylib")
    }

    private func command(entry: String) throws -> [String] {
        let entry = self.packageRoot.appendingPathComponent("dist/\(entry)")
        guard FileManager.default.isReadableFile(atPath: entry.path) else {
            throw MacNodeHostWorker.WorkerError.unavailable(
                reason: "The bundled runtime entry point is missing. Rebuild or reinstall OpenClaw.app.")
        }
        return [self.bun.path, entry.path]
    }
}
