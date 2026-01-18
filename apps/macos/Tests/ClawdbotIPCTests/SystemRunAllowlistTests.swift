import Foundation
import Testing
@testable import Clawdbot

struct SystemRunAllowlistTests {
    @Test func matchUsesResolvedPath() {
        let entry = SystemRunAllowlistEntry(pattern: "/opt/homebrew/bin/rg", enabled: true, matchKind: .glob)
        let resolution = SystemRunCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = SystemRunAllowlistStore.match(
            command: ["rg"],
            resolution: resolution,
            entries: [entry])
        #expect(match?.id == entry.id)
    }

    @Test func matchUsesBasenameForSimplePattern() {
        let entry = SystemRunAllowlistEntry(pattern: "rg", enabled: true, matchKind: .glob)
        let resolution = SystemRunCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = SystemRunAllowlistStore.match(
            command: ["rg"],
            resolution: resolution,
            entries: [entry])
        #expect(match?.id == entry.id)
    }

    @Test func matchUsesLegacyArgvKey() {
        let key = SystemRunAllowlist.legacyKey(for: ["echo", "hi"])
        let entry = SystemRunAllowlistEntry(pattern: key, enabled: true, matchKind: .argv)
        let match = SystemRunAllowlistStore.match(
            command: ["echo", "hi"],
            resolution: nil,
            entries: [entry])
        #expect(match?.id == entry.id)
    }
}
