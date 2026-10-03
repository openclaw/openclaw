import Darwin
import Foundation

extension BundledRuntime {
    enum SeedError: LocalizedError {
        case invalidBuildID
        case invalidCurrent
        case runtimeProbe(String)

        var errorDescription: String? {
            switch self {
            case .invalidBuildID: "The app's runtime build ID is invalid. Reinstall OpenClaw.app."
            case .invalidCurrent: "The seeded runtime link is invalid. Retry OpenClaw setup."
            case let .runtimeProbe(detail): "The bundled Bun runtime could not start: \(detail)"
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
        let source = try self.resolve(bundle: bundle)
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
            // copyItem uses clone-on-write on APFS; publication stays on the same volume.
            try fileManager.copyItem(at: source.root, to: partial)
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
        } else {
            _ = try self.resolve(root: target, bundle: bundle)
        }
        if previous != buildID {
            if let previous {
                try self.replaceBuildLink("previous", target: previous, in: directory)
            } else if try self.buildLink("previous", in: directory) != nil {
                // With current missing, this link cannot identify the immediately previous build.
                try fileManager.removeItem(at: directory.appendingPathComponent("previous"))
            }
            try self.replaceBuildLink("current", target: buildID, in: directory)
        }
        let runtime = try self.resolve(root: target, bundle: bundle)
        let allowsPersistentIntegration = await ApplicationRelocator.currentBundleAllowsPersistentIntegration(
            bundle: bundle)
        runtime.installCLI(
            bundle: bundle,
            profile: profile,
            homeDirectory: homeDirectory,
            allowsPersistentIntegration: allowsPersistentIntegration)
        return runtime
    }

    /// Call only after readiness confirms the replacement Gateway is healthy.
    @concurrent
    static func garbageCollectAfterHealthy(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async throws
    {
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
                  name != "current", name != "previous", !name.contains(".partial-"),
                  let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  let data = try? Data(contentsOf: entry
                      .appendingPathComponent("lib/node_modules/openclaw/dist/build-info.json")),
                  let build = try? JSONDecoder().decode(BuildInfo.self, from: data), build.buildId == name
            else { continue }
            let prefix = entry.resolvingSymlinksInPath().path + "/"
            guard !liveExecutables.contains(where: { $0.hasPrefix(prefix) }) else { continue }
            try FileManager.default.removeItem(at: entry)
        }
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
        let key = profile.stateDirectoryURL(homeDirectory: homeDirectory).path
        if let task = self.pending[key] { return try await task.value }
        let task = Task { try await BundledRuntime.prepareSeed(
            bundle: bundle, profile: profile, homeDirectory: homeDirectory) }
        self.pending[key] = task
        defer { self.pending[key] = nil }
        return try await task.value
    }
}
