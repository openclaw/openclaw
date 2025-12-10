import Foundation
import Testing
@testable import Clawdis

@Suite struct UtilitiesTests {
    @Test func ageStringsCoverCommonWindows() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(age(from: now, now: now) == "just now")
        #expect(age(from: now.addingTimeInterval(-45), now: now) == "just now")
        #expect(age(from: now.addingTimeInterval(-75), now: now) == "1 minute ago")
        #expect(age(from: now.addingTimeInterval(-10 * 60), now: now) == "10m ago")
        #expect(age(from: now.addingTimeInterval(-3_600), now: now) == "1 hour ago")
        #expect(age(from: now.addingTimeInterval(-5 * 3_600), now: now) == "5h ago")
        #expect(age(from: now.addingTimeInterval(-26 * 3_600), now: now) == "yesterday")
        #expect(age(from: now.addingTimeInterval(-3 * 86_400), now: now) == "3d ago")
    }

    @Test func parseSSHTargetSupportsUserPortAndDefaults() {
        let parsed1 = CommandResolver.parseSSHTarget("[redacted-email]:2222")
        #expect(parsed1?.user == "alice")
        #expect(parsed1?.host == "example.com")
        #expect(parsed1?.port == 2222)

        let parsed2 = CommandResolver.parseSSHTarget("example.com")
        #expect(parsed2?.user == nil)
        #expect(parsed2?.host == "example.com")
        #expect(parsed2?.port == 22)

        let parsed3 = CommandResolver.parseSSHTarget("bob@host")
        #expect(parsed3?.user == "bob")
        #expect(parsed3?.host == "host")
        #expect(parsed3?.port == 22)
    }

    @Test func sanitizedTargetStripsLeadingSSHPrefix() {
        UserDefaults.standard.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        UserDefaults.standard.set("ssh  [redacted-email]", forKey: remoteTargetKey)
        defer {
            UserDefaults.standard.removeObject(forKey: connectionModeKey)
            UserDefaults.standard.removeObject(forKey: remoteTargetKey)
        }

        let settings = CommandResolver.connectionSettings()
        #expect(settings.mode == .remote)
        #expect(settings.target == "[redacted-email]")
    }

    @Test func gatewayEntrypointPrefersDistOverBin() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let dist = tmp.appendingPathComponent("dist/index.js")
        let bin = tmp.appendingPathComponent("bin/clawdis.js")
        try FileManager.default.createDirectory(at: dist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bin.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dist.path, contents: Data())
        FileManager.default.createFile(atPath: bin.path, contents: Data())

        let entry = CommandResolver.gatewayEntrypoint(in: tmp)
        #expect(entry == dist.path)
    }

    @Test func logLocatorPicksNewestLogFile() throws {
        let fm = FileManager.default
        let dir = URL(fileURLWithPath: "/tmp/clawdis", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let older = dir.appendingPathComponent("clawdis-old-\(UUID().uuidString).log")
        let newer = dir.appendingPathComponent("clawdis-new-\(UUID().uuidString).log")
        fm.createFile(atPath: older.path, contents: Data("old".utf8))
        fm.createFile(atPath: newer.path, contents: Data("new".utf8))
        try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100)], ofItemAtPath: older.path)
        try fm.setAttributes([.modificationDate: Date()], ofItemAtPath: newer.path)

        let best = LogLocator.bestLogFile()
        #expect(best?.lastPathComponent == newer.lastPathComponent)

        try? fm.removeItem(at: older)
        try? fm.removeItem(at: newer)
    }

    @Test func gatewayEntrypointNilWhenMissing() {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        #expect(CommandResolver.gatewayEntrypoint(in: tmp) == nil)
    }
}
