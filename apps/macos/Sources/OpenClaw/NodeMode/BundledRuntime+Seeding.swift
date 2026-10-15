import Darwin
import Foundation

extension BundledRuntime {
    enum SeedError: LocalizedError {
        case invalidBuildID
        case invalidCurrent
        case runtimeProbe(String)
        case archiveMetadata
        case archiveUnavailable
        case archiveIntegrity
        case archiveExtraction(String)

        var errorDescription: String? {
            switch self {
            case .invalidBuildID: "The app's runtime build ID is invalid. Reinstall OpenClaw.app."
            case .invalidCurrent: "The seeded runtime link is invalid. Retry OpenClaw setup."
            case let .runtimeProbe(detail): "The bundled Bun runtime could not start: \(detail)"
            case .archiveMetadata: "The bundled runtime archive metadata is invalid. Reinstall OpenClaw.app."
            case .archiveUnavailable: "The bundled runtime archive is missing or unreadable. Reinstall OpenClaw.app."
            case .archiveIntegrity: "The bundled runtime archive failed its integrity check. Reinstall OpenClaw.app."
            case let .archiveExtraction(detail):
                "The bundled runtime archive could not be extracted: \(detail). Reinstall OpenClaw.app."
            }
        }
    }

    static func seed(
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async throws -> Self
    {
        try await BundledRuntimeSeeder.shared.seed(bundle: bundle, profile: profile, homeDirectory: homeDirectory)
    }

    /// Private helpers need a concrete runtime without adopting the terminal CLI.
    static func prepare(
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async throws -> Self
    {
        try await BundledRuntimeSeeder.shared.prepare(bundle: bundle, profile: profile, homeDirectory: homeDirectory)
    }

    /// Read-only resolution never executes Bun or selects a checkout/PATH fallback.
    static func seeded(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self?
    {
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        guard let buildID = try self.buildLink("current", in: directory) else { return nil }
        let runtime = Self(root: directory.appendingPathComponent(buildID))
        let build = try JSONDecoder().decode(
            BuildInfo.self, from: Data(contentsOf: runtime.packageRoot.appendingPathComponent("dist/build-info.json")))
        guard build.buildId == buildID,
              FileManager.default.isExecutableFile(atPath: runtime.bun.path),
              FileManager.default.isReadableFile(atPath: runtime.sqliteLibrary.path),
              FileManager.default
                  .isReadableFile(atPath: runtime.packageRoot.appendingPathComponent("openclaw.mjs").path)
        else { throw SeedError.invalidCurrent }
        // A newly updated app must still recognize the old seed so PostUpdate can reseed it.
        return runtime
    }

    @concurrent
    fileprivate static func prepareSeed(bundle: Bundle, profile: AppProfile, homeDirectory: URL) async throws -> Self {
        let (source, archive) = try self.bundlePayload(bundle: bundle)
        guard let buildID = bundle.infoDictionary?["OpenClawRuntimeBuildID"] as? String,
              self.isBuildDirectoryName(buildID)
        else { throw SeedError.invalidBuildID }
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        let target = directory.appendingPathComponent(buildID)
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        if !fileManager.fileExists(atPath: target.path) {
            let partial = directory.appendingPathComponent("\(buildID).partial-\(UUID().uuidString)")
            defer { try? fileManager.removeItem(at: partial) }
            try self.cloneRuntimeTree(from: source.root, to: partial)
            if let archive { try await self.extractArchive(archive, to: partial) }
            let staged = try self.resolve(root: partial, bundle: bundle)
            let result = await ShellExecutor.runDetailed(
                command: [staged.bun.path, "--version"],
                cwd: nil,
                env: staged.environment,
                timeout: CommandResolver.versionProbeTimeout)
            guard result.success, !result.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw SeedError.runtimeProbe(result.errorMessage ?? result.stderr)
            }
            try Task.checkCancellation()
            try fileManager.moveItem(at: partial, to: target)
            return Self(root: target)
        }
        return try self.resolve(root: target, bundle: bundle)
    }

    fileprivate static func selectSeed(
        _ runtime: Self,
        bundle: Bundle,
        profile: AppProfile,
        homeDirectory: URL,
        allowsPersistentIntegration: Bool) throws
    {
        let directory = runtime.root.deletingLastPathComponent()
        let buildID = runtime.root.lastPathComponent
        try self.selectBuild(buildID, current: "current", previous: "previous", in: directory)
        runtime.installCLI(
            bundle: bundle,
            profile: profile,
            homeDirectory: homeDirectory,
            allowsPersistentIntegration: allowsPersistentIntegration)
    }

    static func cloneRuntimeTree(
        from source: URL,
        to destination: URL,
        clone: (String, String, UInt32) -> Int32 = { clonefile($0, $1, $2) }) throws
    {
        // Clone the directory in one syscall; copyItem clones each file separately.
        guard clone(source.path, destination.path, UInt32(CLONE_NOFOLLOW)) != 0 else { return }
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: source, to: destination)
    }
}

private actor BundledRuntimeSeeder {
    static let shared = BundledRuntimeSeeder()
    private var pending: [String: Task<BundledRuntime, Error>] = [:]
    private let logger = Logger(subsystem: "ai.openclaw", category: "bundled-runtime.retention")

    func seed(bundle: Bundle, profile: AppProfile, homeDirectory: URL) async throws -> BundledRuntime {
        let runtime = try await self.prepare(
            bundle: bundle, profile: profile, homeDirectory: homeDirectory, retainForHelper: false)
        let allowsPersistentIntegration = await ApplicationRelocator.currentBundleAllowsPersistentIntegration(
            bundle: bundle)
        // Keep selection and CLI writes serialized after asynchronous preparation.
        try BundledRuntime.selectSeed(
            runtime,
            bundle: bundle,
            profile: profile,
            homeDirectory: homeDirectory,
            allowsPersistentIntegration: allowsPersistentIntegration)
        return runtime
    }

    func prepare(
        bundle: Bundle,
        profile: AppProfile,
        homeDirectory: URL,
        retainForHelper: Bool = true) async throws -> BundledRuntime
    {
        let key = profile.stateDirectoryURL(homeDirectory: homeDirectory).path
        if let task = self.pending[key] { return try await task.value }
        let task = Task { try await BundledRuntime.prepareSeed(
            bundle: bundle, profile: profile, homeDirectory: homeDirectory) }
        self.pending[key] = task
        defer { self.pending[key] = nil }
        let runtime = try await task.value
        // Helpers retain their own builds without changing the terminal CLI's selected runtime.
        if retainForHelper {
            do {
                if try BundledRuntime.selectBuild(
                    runtime.root.lastPathComponent,
                    current: "helper-current",
                    previous: "helper-previous",
                    in: runtime.root.deletingLastPathComponent())
                {
                    try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: homeDirectory)
                }
            } catch {
                self.logger.warning("Runtime helper cleanup failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        return runtime
    }
}
