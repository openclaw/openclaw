import Foundation
import OpenClawKit

/// The signed bundle owns this private runtime; general CLI/Gateway discovery never selects it.
enum BundledNodeWorker {
    private struct BuildInfo: Decodable {
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
        let runtime = try validatedRuntime(bundle: bundle)
        return MacNodeHostWorkerLaunch(
            command: CommandResolver.nodeHostWorkerCommand(
                prefix: runtime.prefix, profile: profile, desktopSharingEnabled: desktopSharingEnabled),
            currentDirectoryURL: runtime.root,
            environment: runtime.environment)
    }

    /// Browser setup needs the same host-local runtime as the node, including on a remote-only Mac.
    /// Keep this fixed operation separate from the external CLI/Gateway resolver.
    static func browserSetupLaunch(
        bundle: Bundle,
        action: ChromeExtensionSetupAction = .install,
        profile: AppProfile = .current) throws -> MacNodeHostWorkerLaunch
    {
        let runtime = try validatedRuntime(bundle: bundle, entry: "extensions/browser/setup-entry.js")
        var environment = runtime.environment
        environment["OPENCLAW_PROFILE"] = profile.name ?? "default"
        return MacNodeHostWorkerLaunch(
            command: runtime.prefix + ["--action", action.rawValue, "--wait-ms", "1000"],
            currentDirectoryURL: runtime.root,
            environment: environment)
    }

    private struct Runtime {
        let prefix: [String]
        let root: URL
        let environment: [String: String]
    }

    private static func validatedRuntime(bundle: Bundle, entry: String = "mac-node-worker.js") throws -> Runtime {
        #if arch(arm64)
        let architecture = "arm64"
        #elseif arch(x86_64)
        let architecture = "x86_64"
        #else
        #error("Unsupported Mac worker architecture")
        #endif
        let root = bundle.bundleURL.appendingPathComponent("Contents/Resources/node-worker/\(architecture)")
        let node = root.appendingPathComponent("bin/node")
        let packageRoot = root.appendingPathComponent("lib/node_modules/openclaw")
        let entry = packageRoot.appendingPathComponent("dist/\(entry)")
        let info = bundle.infoDictionary ?? [:]
        let appBuild = ArtifactBuildInfo(infoDictionary: info)
        do {
            let build = try JSONDecoder().decode(
                BuildInfo.self,
                from: Data(contentsOf: packageRoot.appendingPathComponent("dist/build-info.json")))
            guard build.version == appBuild.version,
                  build.commit == appBuild.gitCommit,
                  build.builtAt == appBuild.buildTimestamp,
                  build.buildId == info["OpenClawWorkerBuildID"] as? String,
                  FileManager.default.isExecutableFile(atPath: node.path),
                  FileManager.default.isReadableFile(atPath: entry.path)
            else {
                throw MacNodeHostWorker.WorkerError.unavailable(reason: "Private worker build does not match this app")
            }
        } catch {
            throw MacNodeHostWorker.WorkerError.unavailable(
                reason: "The bundled node worker is missing or incompatible. Rebuild or reinstall OpenClaw.app.",
                diagnostic: error.localizedDescription)
        }
        return Runtime(
            prefix: [node.path, entry.path],
            root: packageRoot,
            environment: ["PATH": node.deletingLastPathComponent().path])
    }
}
