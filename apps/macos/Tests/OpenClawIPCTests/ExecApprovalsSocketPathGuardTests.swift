import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsSocketPathGuardTests {
    @Test
    func hardenParentDirectoryCreatesDirectoryWith0700Permissions() throws {
        let root = FileManager().temporaryDirectory
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
    func removeExistingSocketRejectsSymlinkPath() throws {
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
    func removeExistingSocketRejectsRegularFilePath() throws {
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
