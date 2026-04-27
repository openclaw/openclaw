import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsSocketPathGuardTests {
    @Test
    func `harden parent directory creates directory with0700 permissions`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let socketPath = root
            .appendingPathComponent("nested", isDirectory: true)
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)

        let parent = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        #expect(FileManager().fileExists(atPath: parent.path))
        let attrs = try FileManager().attributesOfItem(atPath: parent.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden parent directory accepts secure symlink parent`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let target = root.appendingPathComponent("state-target", isDirectory: true)
        let linkedState = root.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: target)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)

        let attrs = try FileManager().attributesOfItem(atPath: target.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden parent directory accepts secure symlink parent under system tmp path`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        let rawTargetRoot = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("openclaw-socket-target-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: root)
            try? FileManager().removeItem(at: rawTargetRoot)
        }
        let target = rawTargetRoot.appendingPathComponent("state-target", isDirectory: true)
        let linkedState = root.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: target)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)

        let attrs = try FileManager().attributesOfItem(atPath: target.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden parent directory rejects writable symlink parent target`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let target = root.appendingPathComponent("state-target", isDirectory: true)
        let linkedState = root.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: target.path)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: target)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected writable symlink parent target rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .parentSymlinkTargetInvalid(path, message):
                #expect(path == linkedState.path)
                #expect(message.contains("group/other-writable"))
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `harden parent directory rejects symlink target through another symlink`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let target = root.appendingPathComponent("state-target", isDirectory: true)
        let intermediate = root.appendingPathComponent("current-state", isDirectory: true)
        let linkedState = root.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        try FileManager().createSymbolicLink(at: intermediate, withDestinationURL: target)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: intermediate)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected symlink target hop rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .parentSymlinkTargetInvalid(path, message):
                #expect(path == linkedState.path)
                #expect(message.contains("resolves through another symlink"))
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `harden parent directory rejects symlink target below writable ancestor`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let sharedParent = root.appendingPathComponent("shared-parent", isDirectory: true)
        let target = sharedParent.appendingPathComponent("state-target", isDirectory: true)
        let linkedState = root.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: sharedParent.path)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: target)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected symlink target ancestor rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .parentSymlinkTargetInvalid(path, message):
                #expect(path == linkedState.path)
                #expect(message.contains("ancestor is group/other-writable"))
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `harden parent directory rejects symlink parent in writable location`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        let target = root.appendingPathComponent("state-target", isDirectory: true)
        let sharedParent = root.appendingPathComponent("shared-link-parent", isDirectory: true)
        let linkedState = sharedParent.appendingPathComponent(".openclaw", isDirectory: true)
        try FileManager().createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        try FileManager().createDirectory(at: sharedParent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: sharedParent.path)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: target)

        let socketPath = linkedState
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected symlink parent location rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .parentSymlinkTargetInvalid(path, message):
                #expect(path == linkedState.path)
                #expect(message.contains("ancestor is group/other-writable"))
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `remove existing socket rejects symlink path`() throws {
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
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
        let root = FileManager().temporaryDirectory.resolvingSymlinksInPath()
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
