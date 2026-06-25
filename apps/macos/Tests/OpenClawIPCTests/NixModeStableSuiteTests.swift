import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct NixModeStableSuiteTests {
    @Test func `does not open redundant suite for app bundle identifier`() {
        let suite = ProcessInfo.stableNixDefaults(bundleIdentifier: launchdLabel)
        #expect(suite == nil)
    }

    @Test func `opens stable suite when bundle identifier differs`() throws {
        let suiteName = "NixModeStableSuiteTests.\(UUID().uuidString)"
        let suite = try #require(ProcessInfo.stableNixDefaults(bundleIdentifier: "ai.openclaw.dev", suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }
    }

    @Test func `resolves from stable suite for app bundles`() throws {
        let suite = try #require(UserDefaults(suiteName: launchdLabel))
        let key = "openclaw.nixMode"
        let prev = suite.object(forKey: key)
        defer {
            if let prev { suite.set(prev, forKey: key) } else { suite.removeObject(forKey: key) }
        }

        suite.set(true, forKey: key)

        let standard = try #require(UserDefaults(suiteName: "NixModeStableSuiteTests.\(UUID().uuidString)"))
        #expect(!standard.bool(forKey: key))

        let resolved = ProcessInfo.resolveNixMode(
            environment: [:],
            standard: standard,
            stableSuite: suite,
            isAppBundle: true)
        #expect(resolved)
    }

    @Test func `ignores stable suite outside app bundles`() throws {
        let suite = try #require(UserDefaults(suiteName: launchdLabel))
        let key = "openclaw.nixMode"
        let prev = suite.object(forKey: key)
        defer {
            if let prev { suite.set(prev, forKey: key) } else { suite.removeObject(forKey: key) }
        }

        suite.set(true, forKey: key)
        let standard = try #require(UserDefaults(suiteName: "NixModeStableSuiteTests.\(UUID().uuidString)"))

        let resolved = ProcessInfo.resolveNixMode(
            environment: [:],
            standard: standard,
            stableSuite: suite,
            isAppBundle: false)
        #expect(!resolved)
    }
}
