import Foundation
import OpenClawKit

/// The signed bundle starts the app's Gateway until its persistent copy is warmed.
struct BundledRuntime: Sendable {
    let root: URL
    let executable: URL
    let packageRoot: URL
    let sqliteLibrary: URL
    let sqliteLibraryOverride: String?

    static var isBundledApp: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    let cliCommand: [String]

    var environment: [String: String] {
        var environment = ["PATH": self.executable.deletingLastPathComponent().path]
        environment["OPENCLAW_SQLITE_LIBRARY"] = self.sqliteLibraryOverride
        return environment
    }

    struct Manifest: Decodable, Equatable, Sendable {
        struct OpenClaw: Decodable, Equatable, Sendable {
            let version: String
            let commit: String
        }

        struct Payload: Decodable, Equatable, Sendable {
            let path: String
            let sizeBytes: Int
            let sha256: String?
        }

        let schemaVersion: Int
        let mode: String
        let buildId: String?
        let openclaw: OpenClaw
        let executable: Payload
        let runtime: Payload
    }

    func manifest() throws -> Manifest {
        try JSONDecoder().decode(
            Manifest.self,
            from: Data(contentsOf: self.root.appendingPathComponent("manifest.json")))
    }

    static func launch(
        bundle: Bundle,
        profile: AppProfile = .current,
        desktopSharingEnabled: Bool? = nil) throws -> MacNodeHostWorkerLaunch
    {
        let runtime = try resolve(bundle: bundle)
        return MacNodeHostWorkerLaunch(
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
        return MacNodeHostWorkerLaunch(
            command: runtime.command(entry: "extensions/browser/setup-entry.js") + [
                "--action", action.rawValue, "--wait-ms", "1000",
            ],
            currentDirectoryURL: runtime.packageRoot,
            environment: environment)
    }

    static func resolve(bundle: Bundle) throws -> Self {
        let root = self.currentBundleURL(bundle).appendingPathComponent("Contents/Resources/runtime")
        return try self.resolve(root: root, bundle: bundle)
    }

    static func resolve(root: URL, bundle: Bundle) throws -> Self {
        let runtime = Self(root: root)
        let info = bundle.infoDictionary ?? [:]
        let appBuild = ArtifactBuildInfo(infoDictionary: info)
        do {
            let manifest = try runtime.validatedManifest()
            guard let runtimeBuildID = info["OpenClawRuntimeBuildID"] as? String,
                  !runtimeBuildID.isEmpty,
                  manifest.openclaw.version == appBuild.version,
                  manifest.openclaw.commit == appBuild.gitCommit,
                  manifest.buildId == runtimeBuildID
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
        self.executable = root.appendingPathComponent("openclaw")
        self.packageRoot = root.appendingPathComponent("runtime")
        self.sqliteLibrary = self.packageRoot.appendingPathComponent("lib/libsqlite3.dylib")
        self.cliCommand = [self.executable.path]
        self.sqliteLibraryOverride = nil
    }

    /// Only rollback consumes the pre-update command; new seeds always use the standalone layout.
    init(retainedCLI cli: GatewayLaunchAgentManager.InstalledServiceCLI) {
        self.executable = URL(fileURLWithPath: cli.prefix[0])
        let standalone = cli.prefix.count == 1
        let directory = self.executable.deletingLastPathComponent()
        self.root = standalone ? directory : directory.deletingLastPathComponent()
        self.packageRoot = self.root.appendingPathComponent(standalone ? "runtime" : "lib/node_modules/openclaw")
        self.sqliteLibrary = cli.sqliteLibrary.map { URL(fileURLWithPath: $0) }
            ?? (standalone ? self.packageRoot : self.root).appendingPathComponent("lib/libsqlite3.dylib")
        self.cliCommand = cli.prefix
        self.sqliteLibraryOverride = cli.sqliteLibrary ?? (standalone ? nil : self.sqliteLibrary.path)
    }

    private func command(entry: String) -> [String] {
        [self.executable.path, self.packageRoot.appendingPathComponent("dist/\(entry)").path]
    }
}
