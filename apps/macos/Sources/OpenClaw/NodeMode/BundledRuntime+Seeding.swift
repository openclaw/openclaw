import Darwin
import Foundation
import OSLog

extension BundledRuntime {
    enum SeedError: LocalizedError {
        case invalidBuildID
        case invalidCurrent
        case migrationRequired
        case warmFailed(String)

        var errorDescription: String? {
            switch self {
            case .invalidBuildID: "The app's runtime build ID is invalid. Reinstall OpenClaw.app."
            case .invalidCurrent: "The seeded runtime link is invalid. Retry OpenClaw setup."
            case .migrationRequired:
                "Stop this profile's Gateway, run the bundled openclaw doctor --fix, then restart OpenClaw."
            case let .warmFailed(reason): "The background runtime preparation failed. " + reason
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

    static func cancelSeeding(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async
    {
        await BundledRuntimeSeeder.shared.cancel(profile: profile, homeDirectory: homeDirectory)
    }

    /// Read-only resolution never executes OpenClaw or selects a checkout/PATH fallback.
    static func seeded(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self?
    {
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        guard let buildID = try self.buildLink("current", in: directory) else { return nil }
        let runtime = Self(root: directory.appendingPathComponent(buildID))
        // A loose-runtime seed is an upgrade input, never a runnable current payload.
        guard FileManager.default.fileExists(atPath: runtime.root.appendingPathComponent("manifest.json").path)
        else { throw SeedError.migrationRequired }
        let manifest = try runtime.validatedManifest()
        guard manifest.buildId == buildID
        else { throw SeedError.invalidCurrent }
        // Ownership and rollback must still recognize seeds from earlier app versions.
        return runtime
    }

    @concurrent
    fileprivate static func prepareSeed(bundle: Bundle, profile: AppProfile, homeDirectory: URL) async throws -> Self {
        try Task.checkCancellation()
        let source = try self.resolve(bundle: bundle)
        let expectedManifest = try source.manifest()
        guard let buildID = bundle.infoDictionary?["OpenClawRuntimeBuildID"] as? String,
              self.isBuildDirectoryName(buildID)
        else { throw SeedError.invalidBuildID }
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        let target = directory.appendingPathComponent(buildID)
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let previous = try self.buildLink("current", in: directory)
        if !fileManager.fileExists(atPath: target.path) {
            let partial = directory.appendingPathComponent("\(buildID).partial-\(UUID().uuidString)")
            defer { try? fileManager.removeItem(at: partial) }
            try self.cloneRuntimeTree(from: source.root, to: partial)
            guard try Self(root: partial).validatedManifest(verifyExecutable: true) == expectedManifest else {
                throw ValidationError.invalidManifest
            }
            try Task.checkCancellation()
            try fileManager.moveItem(at: partial, to: target)
        } else {
            let manifest = try Self(root: target).validatedManifest(verifyExecutable: true)
            // Re-signing the same build changes payload hashes but preserves its seed identity.
            guard manifest.buildId == expectedManifest.buildId,
                  manifest.openclaw == expectedManifest.openclaw,
                  manifest.mode == expectedManifest.mode
            else {
                throw ValidationError.invalidManifest
            }
        }
        let runtime = Self(root: target)
        if !runtime.isWarmed(buildID: buildID) {
            try await runtime.warm(version: expectedManifest.openclaw.version)
            try Task.checkCancellation()
            try runtime.recordWarmed(buildID: buildID)
        }
        try Task.checkCancellation()
        if previous != buildID {
            if let previous {
                try self.replaceBuildLink("previous", target: previous, in: directory)
            } else if try self.buildLink("previous", in: directory) != nil {
                // With current missing, this link cannot identify the immediately previous build.
                try fileManager.removeItem(at: directory.appendingPathComponent("previous"))
            }
            try self.replaceBuildLink("current", target: buildID, in: directory)
        }
        let allowsPersistentIntegration = await ApplicationRelocator.currentBundleAllowsPersistentIntegration(
            bundle: bundle)
        runtime.installCLI(
            bundle: bundle,
            profile: profile,
            homeDirectory: homeDirectory,
            allowsPersistentIntegration: allowsPersistentIntegration)
        Logger(subsystem: "ai.openclaw", category: "bundled-runtime.seed").notice(
            """
            runtime seeded and warmed build=\(buildID, privacy: .public) \
            executable=\(runtime.executable.path, privacy: .public)
            """)
        return runtime
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

    /// Call only after readiness confirms the replacement Gateway is healthy.
    static func garbageCollectAfterHealthy(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async throws
    {
        try await BundledRuntimeSeeder.shared.collect(profile: profile, homeDirectory: homeDirectory)
    }

    fileprivate static func collect(profile: AppProfile, homeDirectory: URL) throws {
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        // A recovered missing current link needs one successful update cycle to reestablish retention.
        guard let current = try self.buildLink("current", in: directory),
              let previous = try self.buildLink("previous", in: directory),
              let liveExecutables = self.liveExecutablePaths()
        else { return }
        let retained = Set([current, previous])
        for entry in try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        {
            let name = entry.lastPathComponent
            guard self.isBuildDirectoryName(name), !retained.contains(name),
                  let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  self.recordedBuildID(at: entry) == name
            else { continue }
            let prefix = entry.resolvingSymlinksInPath().path + "/"
            guard !liveExecutables.contains(where: { $0.hasPrefix(prefix) }) else { continue }
            try FileManager.default.removeItem(at: entry)
        }
    }

    private static func recordedBuildID(at root: URL) -> String? {
        if let manifest = try? Self(root: root).manifest() { return manifest.buildId }
        // Retire pre-standalone seeds only after a healthy replacement, with previous/live retention intact.
        struct LegacyBuild: Decodable { let buildId: String }
        guard let data = try? Data(contentsOf: root
            .appendingPathComponent("lib/node_modules/openclaw/dist/build-info.json"))
        else { return nil }
        return try? JSONDecoder().decode(LegacyBuild.self, from: data).buildId
    }

    private static func isBuildDirectoryName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && name != "current" && name != "previous"
            && !name.contains("/") && !name.contains("\0") && !name.contains(".partial-")
    }

    private static func buildLink(_ name: String, in directory: URL) throws -> String? {
        let url = directory.appendingPathComponent(name)
        let fileManager = FileManager.default
        guard let target = try? fileManager.destinationOfSymbolicLink(atPath: url.path) else {
            if fileManager.fileExists(atPath: url.path) { throw SeedError.invalidCurrent }
            return nil
        }
        guard self.isBuildDirectoryName(target) else { throw SeedError.invalidCurrent }
        return target
    }

    private static func replaceBuildLink(_ name: String, target: String, in directory: URL) throws {
        let temporary = directory.appendingPathComponent(".\(name)-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.createSymbolicLink(atPath: temporary.path, withDestinationPath: target)
        guard rename(temporary.path, directory.appendingPathComponent(name).path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func liveExecutablePaths() -> [String]? {
        let capacity = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
        guard capacity > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(capacity) / MemoryLayout<pid_t>.size + 64)
        let bytes = pids.withUnsafeMutableBytes {
            proc_listpids(UInt32(PROC_UID_ONLY), getuid(), $0.baseAddress, Int32($0.count))
        }
        guard bytes > 0, Int(bytes) < pids.count * MemoryLayout<pid_t>.size else { return nil }
        var paths: [String] = []
        for pid in pids.prefix(Int(bytes) / MemoryLayout<pid_t>.size) where pid > 0 {
            // sys/proc_info.h defines the maximum as 4 * MAXPATHLEN; that macro is not imported into Swift.
            var buffer = [CChar](repeating: 0, count: 4 * Int(PATH_MAX))
            let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
            guard length > 0 else {
                do {
                    guard try ProcessIdentity.birth(pid: pid) != nil else { continue }
                } catch { return nil }
                // An app or package-manager update can unlink a still-running executable.
                // KERN_PROCARGS2 retains its launch path when proc_pidpath reports ENOENT.
                if let path = ProcessArguments.read(pid: pid)?.executablePath, path.hasPrefix("/") {
                    paths.append(path)
                    continue
                }
                // An unreadable live process defers collection.
                return nil
            }
            guard let path = String(bytes: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, encoding: .utf8)
            else { return nil }
            paths.append(path)
        }
        // Foundation canonicalizes /private/var to /var, unlike proc_pidpath. Match both sides identically.
        return paths.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
    }
}

private actor BundledRuntimeSeeder {
    static let shared = BundledRuntimeSeeder()
    private var pending: [String: Task<BundledRuntime, Error>] = [:]

    func seed(bundle: Bundle, profile: AppProfile, homeDirectory: URL) async throws -> BundledRuntime {
        try Task.checkCancellation()
        let key = profile.stateDirectoryURL(homeDirectory: homeDirectory).path
        if let task = self.pending[key] { return try await task.value }
        let task = Task(priority: .utility) { try await BundledRuntime.prepareSeed(
            bundle: bundle, profile: profile, homeDirectory: homeDirectory) }
        self.pending[key] = task
        defer { self.pending[key] = nil }
        return try await task.value
    }

    func collect(profile: AppProfile, homeDirectory: URL) throws {
        // An unpublished final directory can already contain an executable being warmed.
        guard self.pending[profile.stateDirectoryURL(homeDirectory: homeDirectory).path] == nil else { return }
        try BundledRuntime.collect(profile: profile, homeDirectory: homeDirectory)
    }

    func cancel(profile: AppProfile, homeDirectory: URL) async {
        let key = profile.stateDirectoryURL(homeDirectory: homeDirectory).path
        guard let task = self.pending[key] else { return }
        task.cancel()
        _ = try? await task.value
    }
}
