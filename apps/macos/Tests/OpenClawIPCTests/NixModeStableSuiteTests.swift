import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct NixModeStableSuiteTests {
    @Test func resolvesFromStableSuiteForAppBundles() throws {
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

    @Test func ignoresStableSuiteOutsideAppBundles() throws {
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
