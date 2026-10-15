import Darwin
import Foundation

extension BundledRuntime {
    @discardableResult
    static func selectBuild(_ buildID: String, current: String, previous: String, in directory: URL) throws -> Bool {
        let selected = try self.buildLink(current, in: directory)
        guard selected != buildID else { return false }
        if let selected {
            try self.replaceBuildLink(previous, target: selected, in: directory)
        } else if try self.buildLink(previous, in: directory) != nil {
            // With current missing, this link cannot identify the immediately previous build.
            try FileManager.default.removeItem(at: directory.appendingPathComponent(previous))
        }
        try self.replaceBuildLink(current, target: buildID, in: directory)
        return true
    }

    /// Call after Gateway readiness or successful helper preparation establishes a usable replacement.
    @concurrent
    static func garbageCollectAfterHealthy(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) async throws
    {
        let directory = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("runtime")
        var retained = Set<String>()
        var missingPrevious = false
        var completeHelperPair = false
        for (currentName, previousName) in [("current", "previous"), ("helper-current", "helper-previous")] {
            let current = try self.buildLink(currentName, in: directory)
            let previous = try self.buildLink(previousName, in: directory)
            if let current {
                retained.insert(current)
                if let previous {
                    retained.insert(previous)
                    if currentName == "helper-current" { completeHelperPair = true }
                } else {
                    missingPrevious = true
                }
            } else if previous != nil {
                return
            }
        }
        // Helpers can advance while a terminal CLI remains pinned to its first build.
        // Without that independent lifecycle, retain the Gateway's missing-history recovery grace period.
        guard !retained.isEmpty, !missingPrevious || completeHelperPair,
              let liveExecutables = self.liveExecutablePaths()
        else { return }
        for entry in try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        {
            let name = entry.lastPathComponent
            guard self.isBuildDirectoryName(name), !retained.contains(name),
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

    static func isBuildDirectoryName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && name != "current" && name != "previous"
            && name != "helper-current" && name != "helper-previous"
            && !name.contains("/") && !name.contains("\0") && !name.contains(".partial-")
    }

    static func buildLink(_ name: String, in directory: URL) throws -> String? {
        let url = directory.appendingPathComponent(name)
        let fileManager = FileManager.default
        guard let target = try? fileManager.destinationOfSymbolicLink(atPath: url.path) else {
            if fileManager.fileExists(atPath: url.path) { throw SeedError.invalidCurrent }
            return nil
        }
        guard self.isBuildDirectoryName(target) else { throw SeedError.invalidCurrent }
        return target
    }

    static func replaceBuildLink(_ name: String, target: String, in directory: URL) throws {
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
