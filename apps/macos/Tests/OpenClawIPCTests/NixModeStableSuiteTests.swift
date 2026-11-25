import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
struct NixModeStableSuiteTests {
    @Test func `does not select a stable suite for the app's own bundle identifier`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(bundleIdentifier: launchdLabel, isAppBundle: true) == nil)
    }

    @Test func `selects the stable suite for renamed app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: true) == launchdLabel)
    }

    @Test func `does not select a stable suite outside app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: false) == nil)
    }

    @Test func `resolves Nix mode from independent defaults domains and environment`() throws {
        let standardName = "NixModeStableSuiteTests.standard.\(UUID().uuidString)"
        let standard = try #require(UserDefaults(suiteName: standardName))
        defer { standard.removePersistentDomain(forName: standardName) }
        let stableName = "NixModeStableSuiteTests.stable.\(UUID().uuidString)"
        let stable = try #require(UserDefaults(suiteName: stableName))
        defer { stable.removePersistentDomain(forName: stableName) }
        let key = "openclaw.nixMode"
        struct Scenario {
            let environment: String?
            let standard: Bool
            let stable: Bool?
            let isApp: Bool
            let expected: Bool
        }
        let cases: [Scenario] = [
            .init(environment: nil, standard: false, stable: nil, isApp: true, expected: false),
            .init(environment: nil, standard: false, stable: false, isApp: true, expected: false),
            .init(environment: nil, standard: false, stable: true, isApp: true, expected: true),
            .init(environment: nil, standard: false, stable: true, isApp: false, expected: false),
            .init(environment: nil, standard: true, stable: false, isApp: true, expected: true),
            .init(environment: nil, standard: true, stable: true, isApp: false, expected: true),
            .init(environment: "1", standard: false, stable: false, isApp: true, expected: true),
            .init(environment: "1", standard: false, stable: nil, isApp: false, expected: true),
            .init(environment: "0", standard: false, stable: false, isApp: true, expected: false),
            .init(environment: "0", standard: true, stable: false, isApp: false, expected: true),
            .init(environment: "0", standard: false, stable: true, isApp: true, expected: true),
            .init(environment: "true", standard: false, stable: false, isApp: true, expected: false),
        ]
        for input in cases {
            standard.set(input.standard, forKey: key)
            stable.set(input.stable ?? false, forKey: key)
            #expect(ProcessInfo.resolveNixMode(
                environment: input.environment.map { ["OPENCLAW_NIX_MODE": $0] } ?? [:],
                standard: standard,
                stableSuite: input.stable == nil ? nil : stable,
                isAppBundle: input.isApp) == input.expected, "\(input)")
        }
    }

    @Test func `detects the live test runner across concurrent reads`() async {
        await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<32 {
                group.addTask { ProcessInfo.processInfo.isRunningTests }
            }
            for await isRunningTests in group {
                #expect(isRunningTests)
            }
        }
    }

    @Test func `detects SwiftPM and XCTest runners`() {
        #expect(OpenClawProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "swiftpm-testing-helper",
            arguments: [],
            bundleURLs: []))
        #expect(OpenClawProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "swiftpm-xctest-helper",
            arguments: [],
            bundleURLs: []))
        for helper in ["swiftpm-testing-helper", "swiftpm-xctest-helper"] {
            #expect(OpenClawProcessInfo.resolveIsRunningTests(
                environment: [:],
                processName: "OpenClawTests",
                arguments: ["/Library/Developer/Toolchains/usr/libexec/swift/pm/\(helper)"],
                bundleURLs: []))
        }
        #expect(OpenClawProcessInfo.resolveIsRunningTests(
            environment: ["XCTestSessionIdentifier": "session"],
            processName: "OpenClawTests",
            arguments: [],
            bundleURLs: []))
        #expect(OpenClawProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "OpenClawTests",
            arguments: [],
            bundleURLs: [URL(fileURLWithPath: "/tmp/OpenClawTests.xctest")]))
        #expect(!OpenClawProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "OpenClaw",
            arguments: [],
            bundleURLs: []))
    }
}
