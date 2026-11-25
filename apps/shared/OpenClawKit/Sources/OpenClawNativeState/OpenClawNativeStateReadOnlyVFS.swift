import Foundation
import SQLite3

/// Keeps Apple's read-only main database connection compatible with a checkpointed WAL database.
enum OpenClawNativeStateReadOnlyVFS {
    private static let vfsName = "openclaw-native-readonly-wal"
    private static let registration: Result<Registration, Error> = Result { try Registration() }

    static func name() throws -> String {
        _ = try self.registration.get()
        return self.vfsName
    }

    /// SQLite retains these C pointers for the process lifetime. Registration is initialized once;
    /// its storage and delegated callbacks remain unchanged after publication to SQLite.
    private final class Registration: @unchecked Sendable {
        let original: UnsafeMutablePointer<sqlite3_vfs>
        let registered: UnsafeMutablePointer<sqlite3_vfs>
        let name: UnsafeMutablePointer<CChar>

        init() throws {
            guard let original = sqlite3_vfs_find(nil), original.pointee.xOpen != nil,
                  let name = strdup(OpenClawNativeStateReadOnlyVFS.vfsName)
            else {
                throw OpenClawNativeStateError("Could not initialize the native read-only SQLite VFS")
            }
            let registered = UnsafeMutablePointer<sqlite3_vfs>.allocate(capacity: 1)
            registered.initialize(to: original.pointee)
            registered.pointee.pNext = nil
            registered.pointee.zName = UnsafePointer(name)
            registered.pointee.xOpen = { _, path, file, flags, outputFlags in
                guard case let .success(registration) = OpenClawNativeStateReadOnlyVFS.registration,
                      let open = registration.original.pointee.xOpen
                else { return SQLITE_CANTOPEN }
                var flags = flags
                if flags & SQLITE_OPEN_WAL != 0 {
                    // Apple opens WAL files read-only without CREATE, so a normally checkpointed
                    // database fails with CANTOPEN after its last writer removes the sidecars.
                    // Match upstream sqlite3WalOpen; the main database remains read-only.
                    flags = (flags & ~SQLITE_OPEN_READONLY) | SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
                }
                return open(registration.original, path, file, flags, outputFlags)
            }
            let result = sqlite3_vfs_register(registered, 0)
            guard result == SQLITE_OK else {
                registered.deinitialize(count: 1)
                registered.deallocate()
                free(name)
                throw OpenClawNativeStateError("Could not register the native read-only SQLite VFS: \(result)")
            }
            self.original = original
            self.registered = registered
            self.name = name
        }
    }
}
