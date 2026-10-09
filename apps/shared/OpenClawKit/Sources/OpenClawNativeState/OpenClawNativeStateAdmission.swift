import CryptoKit
import Darwin
import Foundation
import SQLite3
#if canImport(Security)
import Security
#endif

/// Observes the process owner; native connections never create coordination files.
struct OpenClawNativeStateAdmission {
    struct DatabaseIdentity: Equatable {
        let device: dev_t
        let inode: ino_t
    }

    private enum ProcessRole: String, Decodable {
        case gateway
        case agentEmbedded = "agent-embedded"
        case skillWorkshopApply = "skill-workshop-apply"
        case sqliteMaintenance = "sqlite-maintenance"
    }

    private struct ProcessOwner: Decodable {
        let pid: pid_t
        let createdAt: String
        let configPath: String
        let role: ProcessRole?
        let startTime: UInt64?
    }

    private let ownerURL: URL?

    init(databaseURL: URL) throws {
        #if os(macOS) && canImport(Security)
        let sandboxed: Bool = if let task = SecTaskCreateFromSelf(nil) {
            (SecTaskCopyValueForEntitlement(task, "com.apple.security.app-sandbox" as CFString, nil)
                as? Bool) == true
        } else {
            ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
        }
        self.ownerURL = sandboxed ? nil : try Self.processOwnerURL(
            databaseURL: databaseURL,
            uid: getuid())
        #else
        // Sandboxed native profiles cannot share state with a Node maintenance process.
        self.ownerURL = nil
        #endif
        try self.assertAvailable()
    }

    static func processOwnerURL(databaseURL: URL, uid: uid_t) throws -> URL {
        let canonicalDatabase = try self.canonicalExistingAncestorPath(databaseURL)
        let databaseDirectory = URL(fileURLWithPath: canonicalDatabase).deletingLastPathComponent()
        let stateRoot = databaseDirectory.lastPathComponent == "state"
            ? databaseDirectory.deletingLastPathComponent()
            : databaseDirectory
        let digest = SHA256.hash(data: Data(canonicalDatabase.utf8))
        let hash = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        return stateRoot
            .appendingPathComponent("tmp", isDirectory: true)
            .appendingPathComponent("openclaw-\(uid)", isDirectory: true)
            .appendingPathComponent("state.\(hash).lock", isDirectory: false)
    }

    func assertAvailable() throws {
        guard let ownerURL else { return }
        let data: Data
        do {
            let handle = try FileHandle(forReadingFrom: ownerURL)
            defer { try? handle.close() }
            data = try handle.read(upToCount: 65537) ?? Data()
        } catch let error as NSError where
            (error.domain == NSCocoaErrorDomain
                && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError))
            || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
        {
            return
        }
        guard data.count <= 65536,
              let owner = try? JSONDecoder().decode(ProcessOwner.self, from: data), owner.pid > 0
        else {
            throw OpenClawNativeStateError("OpenClaw state ownership is being acquired; retry after maintenance")
        }
        if kill(owner.pid, 0) != 0, errno == ESRCH { return }
        #if os(macOS)
        if let expectedStart = owner.startTime {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            if proc_pidinfo(owner.pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
               info.pbi_start_tvsec != expectedStart
            {
                return
            }
        }
        #endif
        guard owner.role == nil || owner.role == .gateway || owner.role == .agentEmbedded else {
            throw OpenClawNativeStateError("OpenClaw state is undergoing offline maintenance; retry when it finishes")
        }
    }

    static func databaseIdentity(at url: URL) throws -> DatabaseIdentity {
        var info = stat()
        guard stat(url.path, &info) == 0 else {
            throw OpenClawNativeStateError("Native state database was moved or removed; reopen it before use")
        }
        return DatabaseIdentity(device: info.st_dev, inode: info.st_ino)
    }

    static func assertDatabaseHasNotMoved(_ database: OpaquePointer) throws {
        var moved: Int32 = 0
        let result = sqlite3_file_control(database, "main", SQLITE_FCNTL_HAS_MOVED, &moved)
        guard (result == SQLITE_OK && moved == 0) || result == SQLITE_NOTFOUND else {
            throw OpenClawNativeStateError("Native state database was moved or replaced; reopen it before use")
        }
    }

    private static func canonicalExistingAncestorPath(_ url: URL) throws -> String {
        var current = url.standardizedFileURL
        var missing: [String] = []
        while !FileManager.default.fileExists(atPath: current.path) {
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { break }
            missing.append(current.lastPathComponent)
            current = parent
        }
        // Preserve /private on macOS so this key matches Node's realpath result.
        guard let resolved = realpath(current.path, nil) else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { free(resolved) }
        var canonical = String(cString: resolved)
        for component in missing.reversed() {
            canonical += canonical == "/" ? component : "/" + component
        }
        return canonical
    }
}
