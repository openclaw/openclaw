import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsSocketPathGuardTests {
    @Test
    func `ancestor safety requires root or current owner`() {
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o755,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 501,
            permissions: 0o700,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 502,
            permissions: 0o755,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o1777,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o777,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 0,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 501,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 502,
            expectedOwner: 501))
    }

    @Test
    func `harden canonical parent directory creates it with0700 permissions`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let socketPath = ExecApprovalsStore.socketPath()
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)

            #expect(FileManager().fileExists(atPath: stateDir.path))
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    @Test
    func `harden custom socket parent creates nested private directories`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-custom-socket-\(UUID().uuidString)", isDirectory: true)
        let parent = root.appendingPathComponent("nested/private", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: parent.appendingPathComponent("approvals.sock").path)

        let attrs = try FileManager().attributesOfItem(atPath: parent.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden existing custom parent does not change permissions`() throws {
        let parent = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-existing-socket-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: parent) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path)

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: parent.appendingPathComponent("approvals.sock").path)

        let attrs = try FileManager().attributesOfItem(atPath: parent.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o755)
    }

    @Test
    func `harden existing private parent rejects unsafe ancestor`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-unsafe-socket-\(UUID().uuidString)", isDirectory: true)
        let parent = root.appendingPathComponent("private", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: root.path)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(
                for: parent.appendingPathComponent("approvals.sock").path)
            Issue.record("Expected unsafe ancestor rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            guard case let .parentPermissionsUnsafe(path, _) = error else {
                Issue.record("Unexpected error: \(error)")
                return
            }
            #expect(path == root.resolvingSymlinksInPath().path)
        }
    }

    @Test
    func `harden parent directory rejects shared tmp without chmod`() throws {
        let sharedTmp = "/private/tmp"
        let before = try FileManager().attributesOfItem(atPath: sharedTmp)
        let beforePermissions = (before[.posixPermissions] as? NSNumber)?.intValue ?? -1
        let socketPath = "\(sharedTmp)/openclaw-exec-approvals-\(UUID().uuidString).sock"

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected shared tmp parent rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case .parentOwnerInvalid, .parentPermissionsUnsafe:
                break
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }

        let after = try FileManager().attributesOfItem(atPath: sharedTmp)
        let afterPermissions = (after[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(afterPermissions == beforePermissions)
    }

    @Test
    func `socket lease blocks replacement until current owner releases`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-takeover-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path

        let result = await ExecApprovalsPromptServer._testSocketLeaseHandoff(socketPath: socketPath)

        #expect(result.replacementBlockedWhileOwned)
        #expect(result.replacementStartedAfterRelease)
        #expect(result.replacementHasDistinctIdentity)
        #expect(result.replacementPreserved)
    }

    @Test
    func `remove existing socket rejects symlink path`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        let target = root.appendingPathComponent("target.txt")
        _ = FileManager().createFile(atPath: target.path, contents: Data("x".utf8))
        let symlink = root.appendingPathComponent("exec-approvals.sock")
        try FileManager().createSymbolicLink(at: symlink, withDestinationURL: target)

        do {
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: symlink.path)
            Issue.record("Expected symlink socket path rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .socketPathInvalid(path, kind):
                #expect(path == symlink.path)
                #expect(kind == .symlink)
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `remove existing socket rejects regular file path`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        let regularFile = root.appendingPathComponent("exec-approvals.sock")
        _ = FileManager().createFile(atPath: regularFile.path, contents: Data("x".utf8))

        do {
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: regularFile.path)
            Issue.record("Expected non-socket path rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .socketPathInvalid(path, kind):
                #expect(path == regularFile.path)
                #expect(kind == .other)
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }
}
