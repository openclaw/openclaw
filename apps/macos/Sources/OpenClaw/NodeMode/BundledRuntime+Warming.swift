import Darwin
import Foundation
import Subprocess

extension BundledRuntime {
    private static let warmedAttribute = "ai.openclaw.runtime.warmed"

    /// App-internal commands can run in place; durable CLI and service pins wait for seed().
    static func forAppHosting(
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self
    {
        let source = try self.resolve(bundle: bundle)
        return (try? self.readySeed(bundle: bundle, profile: profile, homeDirectory: homeDirectory)) ?? source
    }

    static func readySeed(
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self?
    {
        guard let runtime = try self.seeded(profile: profile, homeDirectory: homeDirectory),
              runtime.root.lastPathComponent == bundle.infoDictionary?["OpenClawRuntimeBuildID"] as? String,
              runtime.isWarmed(buildID: runtime.root.lastPathComponent)
        else { return nil }
        return runtime
    }

    static func currentBundleURL(_ bundle: Bundle) -> URL {
        guard bundle === Bundle.main,
              let executable = ProcessIdentity.executablePath(pid: getpid())
        else { return bundle.bundleURL }
        // NSBundle caches its URL. The kernel tracks a running app through Finder moves/renames.
        let candidate = URL(fileURLWithPath: executable).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return candidate.pathExtension == "app" ? candidate : bundle.bundleURL
    }

    func isWarmed(buildID: String) -> Bool {
        let expected = Array(buildID.utf8)
        var stored = [UInt8](repeating: 0, count: expected.count)
        let size = stored.withUnsafeMutableBytes {
            getxattr(self.root.path, Self.warmedAttribute, $0.baseAddress, $0.count, 0, 0)
        }
        return size == expected.count && stored == expected
    }

    func recordWarmed(buildID: String) throws {
        // Mark the seed directory, never the executable: changing its metadata can trigger reassessment.
        let bytes = Array(buildID.utf8)
        let result = bytes.withUnsafeBytes {
            setxattr(self.root.path, Self.warmedAttribute, $0.baseAddress, bytes.count, 0, 0)
        }
        guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    func warm(version: String) async throws {
        var options = PlatformOptions()
        options.qualityOfService = .utility
        options.createSession = true
        options.teardownSequence = [.send(signal: .kill, toProcessGroup: true, allowedDurationToNextStep: .zero)]
        let result = try await Subprocess.run(
            Configuration(
                executable: .path(.init(self.executable.path)),
                arguments: ["--version"],
                environment: ManagedProcess.environment(from: self.environment),
                workingDirectory: .init(self.packageRoot.path),
                platformOptions: options),
            input: .none,
            output: .bytes(limit: 64 * 1024),
            error: .combinedWithOutput)
        try Task.checkCancellation()
        guard let output = String(bytes: result.standardOutput, encoding: .utf8) else {
            throw SeedError.warmFailed("The runtime returned invalid version output.")
        }
        guard result.terminationStatus.isSuccess,
              GatewayEnvironment.normalizeGatewayVersionOutput(output) == version
        else { throw SeedError.warmFailed(output.suffix(2000).description) }
    }
}
