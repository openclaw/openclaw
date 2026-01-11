import Foundation
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
struct CLIInstallerTests {
    @Test func installedLocationOnlyAcceptsEmbeddedHelper() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(
            "clawdbot-cli-installer-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let embedded = root.appendingPathComponent("Relay/clawdbot")
        try fm.createDirectory(at: embedded.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: embedded.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: embedded.path)

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let link = binDir.appendingPathComponent("clawdbot")
        try fm.createSymbolicLink(at: link, withDestinationURL: embedded)

        let found = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            embeddedHelper: embedded,
            fileManager: fm)
        #expect(found == link.path)

        try fm.removeItem(at: link)
        let other = root.appendingPathComponent("Other/clawdbot")
        try fm.createDirectory(at: other.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: other.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: other.path)
        try fm.createSymbolicLink(at: link, withDestinationURL: other)

        let rejected = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            embeddedHelper: embedded,
            fileManager: fm)
        #expect(rejected == nil)
    }
}
