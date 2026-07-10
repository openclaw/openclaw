import Darwin
import Foundation

enum ExecApprovalsSocketPathKind: Equatable {
    case missing
    case directory
    case socket
    case symlink
    case other
}

struct ExecApprovalsSocketPathIdentity: Equatable, Sendable {
    let device: UInt64
    let inode: UInt64
}

enum ExecApprovalsSocketPathGuardError: LocalizedError {
    case lstatFailed(path: String, code: Int32)
    case parentPathInvalid(path: String, kind: ExecApprovalsSocketPathKind)
    case parentOwnerInvalid(path: String, owner: uid_t, expected: uid_t)
    case parentAncestorOwnerInvalid(path: String, owner: uid_t)
    case parentSymlinkOwnerInvalid(path: String, owner: uid_t)
    case parentPermissionsUnsafe(path: String, permissions: mode_t)
    case socketPathInvalid(path: String, kind: ExecApprovalsSocketPathKind)
    case unlinkFailed(path: String, code: Int32)
    case createParentDirectoryFailed(path: String, message: String)
    case setParentDirectoryPermissionsFailed(path: String, message: String)
    case lifecycleLockOpenFailed(path: String, code: Int32)
    case lifecycleLockInvalid(path: String)
    case lifecycleLockBusy(path: String)

    var errorDescription: String? {
        switch self {
        case let .lstatFailed(path, code):
            "lstat failed for \(path) (errno \(code))"
        case let .parentPathInvalid(path, kind):
            "socket parent path invalid (\(kind)) at \(path)"
        case let .parentOwnerInvalid(path, owner, expected):
            "socket parent directory owner invalid at \(path) (uid \(owner), expected \(expected))"
        case let .parentAncestorOwnerInvalid(path, owner):
            "socket parent ancestor owner invalid at \(path) (uid \(owner))"
        case let .parentSymlinkOwnerInvalid(path, owner):
            "socket parent symlink owner invalid at \(path) (uid \(owner))"
        case let .parentPermissionsUnsafe(path, permissions):
            "socket parent directory permissions unsafe at \(path) (mode \(String(permissions, radix: 8)))"
        case let .socketPathInvalid(path, kind):
            "socket path invalid (\(kind)) at \(path)"
        case let .unlinkFailed(path, code):
            "unlink failed for \(path) (errno \(code))"
        case let .createParentDirectoryFailed(path, message):
            "socket parent directory create failed at \(path): \(message)"
        case let .setParentDirectoryPermissionsFailed(path, message):
            "socket parent directory chmod failed at \(path): \(message)"
        case let .lifecycleLockOpenFailed(path, code):
            "socket lifecycle lock open failed at \(path) (errno \(code))"
        case let .lifecycleLockInvalid(path):
            "socket lifecycle lock is unsafe at \(path)"
        case let .lifecycleLockBusy(path):
            "socket lifecycle lock is already held at \(path)"
        }
    }
}

enum ExecApprovalsSocketPathGuard {
    static let parentDirectoryPermissions = 0o700

    static func pathKind(at path: String) throws -> ExecApprovalsSocketPathKind {
        var status = stat()
        let result = lstat(path, &status)
        if result != 0 {
            if errno == ENOENT {
                return .missing
            }
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }

        let fileType = status.st_mode & mode_t(S_IFMT)
        if fileType == mode_t(S_IFDIR) {
            return .directory
        }
        if fileType == mode_t(S_IFSOCK) {
            return .socket
        }
        if fileType == mode_t(S_IFLNK) {
            return .symlink
        }
        return .other
    }

    static func socketIdentity(at path: String) throws -> ExecApprovalsSocketPathIdentity? {
        var status = stat()
        let result = lstat(path, &status)
        if result != 0 {
            if errno == ENOENT {
                return nil
            }
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else { return nil }
        return ExecApprovalsSocketPathIdentity(
            device: UInt64(truncatingIfNeeded: status.st_dev),
            inode: UInt64(truncatingIfNeeded: status.st_ino))
    }

    static func hardenParentDirectory(for socketPath: String) throws {
        guard socketPath.hasPrefix("/") else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: socketPath,
                kind: .other)
        }
        let parentURL = URL(fileURLWithPath: socketPath)
            .deletingLastPathComponent()
            .standardizedFileURL
        let parentPath = parentURL.path

        switch try self.pathKind(at: parentPath) {
        case .missing:
            try self.createSecureDirectoryTree(
                at: self.canonicalMissingDirectoryURL(parentURL))
            try self.validateLexicalDirectoryChain(at: parentURL)
        case .directory:
            // Existing directories may be shared or operator-managed. Verify
            // them but never chmod them as a side effect of listener startup.
            try self.validateLexicalDirectoryChain(at: parentURL)
            try self.validateDirectoryChain(at: parentURL.resolvingSymlinksInPath())
            try self.validateParentDirectory(at: parentPath)
            return
        case let kind:
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(path: parentPath, kind: kind)
        }
    }

    private static func canonicalMissingDirectoryURL(_ directory: URL) throws -> URL {
        var existingAncestor = directory
        var missingComponents: [String] = []
        while try self.pathKind(at: existingAncestor.path) == .missing {
            let component = existingAncestor.lastPathComponent
            guard !component.isEmpty, existingAncestor.path != "/" else {
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: directory.path,
                    kind: .other)
            }
            missingComponents.insert(component, at: 0)
            existingAncestor.deleteLastPathComponent()
        }
        let ancestorKind = try self.pathKind(at: existingAncestor.path)
        guard ancestorKind == .directory else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: existingAncestor.path,
                kind: ancestorKind)
        }
        try self.validateLexicalDirectoryChain(at: existingAncestor)
        var canonical = existingAncestor.resolvingSymlinksInPath()
        for component in missingComponents {
            canonical.appendPathComponent(component, isDirectory: true)
        }
        return canonical
    }

    private static func createSecureDirectoryTree(at directory: URL) throws {
        let components = directory.standardizedFileURL.pathComponents
        guard components.first == "/" else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: directory.path,
                kind: .other)
        }

        var cursor = URL(fileURLWithPath: "/", isDirectory: true)
        var createdPath = false
        var createdDirectories = Set<String>()
        for component in components.dropFirst() {
            cursor.appendPathComponent(component, isDirectory: true)
            var status = stat()
            if lstat(cursor.path, &status) != 0 {
                guard errno == ENOENT else {
                    throw ExecApprovalsSocketPathGuardError.lstatFailed(
                        path: cursor.path,
                        code: errno)
                }
                if mkdir(cursor.path, mode_t(self.parentDirectoryPermissions)) == 0 {
                    createdDirectories.insert(cursor.path)
                } else if errno != EEXIST {
                    let code = errno
                    throw ExecApprovalsSocketPathGuardError.createParentDirectoryFailed(
                        path: cursor.path,
                        message: POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO).localizedDescription)
                }
                createdPath = true
                if lstat(cursor.path, &status) != 0 {
                    throw ExecApprovalsSocketPathGuardError.lstatFailed(
                        path: cursor.path,
                        code: errno)
                }
            }

            guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
                let kind = try self.pathKind(at: cursor.path)
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: cursor.path,
                    kind: kind)
            }
            let permissions = status.st_mode & mode_t(0o7777)
            if createdPath {
                guard status.st_uid == geteuid() else {
                    throw ExecApprovalsSocketPathGuardError.parentOwnerInvalid(
                        path: cursor.path,
                        owner: status.st_uid,
                        expected: geteuid())
                }
                guard permissions & mode_t(0o022) == 0 else {
                    throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                        path: cursor.path,
                        permissions: permissions)
                }
            } else {
                try self.validateAncestorDirectory(
                    status: status,
                    path: cursor.path,
                    permissions: permissions)
            }
        }

        if createdDirectories.contains(directory.path) {
            do {
                try FileManager().setAttributes(
                    [.posixPermissions: self.parentDirectoryPermissions],
                    ofItemAtPath: directory.path)
            } catch {
                throw ExecApprovalsSocketPathGuardError.setParentDirectoryPermissionsFailed(
                    path: directory.path,
                    message: error.localizedDescription)
            }
        }
        try self.validateParentDirectory(at: directory.path)
    }

    private static func validateDirectoryChain(at directory: URL) throws {
        let components = directory.standardizedFileURL.pathComponents
        guard components.first == "/" else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: directory.path,
                kind: .other)
        }
        var cursor = URL(fileURLWithPath: "/", isDirectory: true)
        for component in components.dropFirst() {
            cursor.appendPathComponent(component, isDirectory: true)
            var status = stat()
            guard lstat(cursor.path, &status) == 0 else {
                throw ExecApprovalsSocketPathGuardError.lstatFailed(
                    path: cursor.path,
                    code: errno)
            }
            guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
                let kind = try self.pathKind(at: cursor.path)
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: cursor.path,
                    kind: kind)
            }
            try self.validateAncestorDirectory(
                status: status,
                path: cursor.path,
                permissions: status.st_mode & mode_t(0o7777))
        }
    }

    private static func validateLexicalDirectoryChain(at directory: URL) throws {
        let components = directory.standardizedFileURL.pathComponents
        guard components.first == "/" else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: directory.path,
                kind: .other)
        }
        var cursor = URL(fileURLWithPath: "/", isDirectory: true)
        for component in components.dropFirst() {
            cursor.appendPathComponent(component, isDirectory: true)
            var status = stat()
            guard lstat(cursor.path, &status) == 0 else {
                throw ExecApprovalsSocketPathGuardError.lstatFailed(
                    path: cursor.path,
                    code: errno)
            }
            let fileType = status.st_mode & mode_t(S_IFMT)
            if fileType == mode_t(S_IFLNK) {
                guard self.symlinkOwnerIsSafe(
                    owner: status.st_uid,
                    expectedOwner: geteuid())
                else {
                    throw ExecApprovalsSocketPathGuardError.parentSymlinkOwnerInvalid(
                        path: cursor.path,
                        owner: status.st_uid)
                }
                continue
            }
            guard fileType == mode_t(S_IFDIR) else {
                let kind = try self.pathKind(at: cursor.path)
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: cursor.path,
                    kind: kind)
            }
            try self.validateAncestorDirectory(
                status: status,
                path: cursor.path,
                permissions: status.st_mode & mode_t(0o7777))
        }
    }

    private static func validateAncestorDirectory(
        status: stat,
        path: String,
        permissions: mode_t) throws
    {
        guard self.ancestorDirectoryIsSafe(
            owner: status.st_uid,
            permissions: permissions,
            expectedOwner: geteuid())
        else {
            if status.st_uid != 0, status.st_uid != geteuid() {
                throw ExecApprovalsSocketPathGuardError.parentAncestorOwnerInvalid(
                    path: path,
                    owner: status.st_uid)
            }
            throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                path: path,
                permissions: permissions)
        }
    }

    static func ancestorDirectoryIsSafe(
        owner: uid_t,
        permissions: mode_t,
        expectedOwner: uid_t) -> Bool
    {
        guard owner == 0 || owner == expectedOwner else { return false }
        guard permissions & mode_t(0o022) != 0 else { return true }
        return permissions & mode_t(S_ISVTX) != 0
    }

    static func symlinkOwnerIsSafe(owner: uid_t, expectedOwner: uid_t) -> Bool {
        owner == 0 || owner == expectedOwner
    }

    private static func validateParentDirectory(at path: String) throws {
        var status = stat()
        if lstat(path, &status) != 0 {
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
            let kind = try self.pathKind(at: path)
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: path,
                kind: kind)
        }
        let expectedOwner = geteuid()
        guard status.st_uid == expectedOwner else {
            throw ExecApprovalsSocketPathGuardError.parentOwnerInvalid(
                path: path,
                owner: status.st_uid,
                expected: expectedOwner)
        }
        let permissions = status.st_mode & mode_t(0o777)
        guard permissions & mode_t(0o022) == 0 else {
            throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                path: path,
                permissions: permissions)
        }
    }

    static func removeExistingSocket(at socketPath: String) throws {
        let kind = try self.pathKind(at: socketPath)
        switch kind {
        case .missing:
            return
        case .socket:
            break
        case .directory, .symlink, .other:
            throw ExecApprovalsSocketPathGuardError.socketPathInvalid(path: socketPath, kind: kind)
        }
        if unlink(socketPath) != 0, errno != ENOENT {
            throw ExecApprovalsSocketPathGuardError.unlinkFailed(path: socketPath, code: errno)
        }
    }

    @discardableResult
    static func removeSocket(
        at socketPath: String,
        ifIdentityMatches expectedIdentity: ExecApprovalsSocketPathIdentity) throws -> Bool
    {
        guard try self.socketIdentity(at: socketPath) == expectedIdentity else { return false }
        if unlink(socketPath) != 0 {
            if errno == ENOENT {
                return false
            }
            throw ExecApprovalsSocketPathGuardError.unlinkFailed(path: socketPath, code: errno)
        }
        return true
    }
}
