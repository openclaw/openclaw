import Foundation
import Testing
@testable import OpenClaw

struct LaunchAgentManagerTests {
    @Test func `launch at login plist does not keep app alive after manual quit`() throws {
        let object = try Self.parsePlist(
            LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app"))

        #expect(object["RunAtLoad"] as? Bool == true)
        #expect(object["KeepAlive"] == nil)

        let args = try #require(object["ProgramArguments"] as? [String])
        #expect(args == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
    }

    @Test func `launch at login plist preserves profile environment`() async throws {
        let stateDir = "/tmp/openclaw state & profile"
        let configPath = "/tmp/openclaw state & profile/custom<profile>.json"

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_STATE_DIR": stateDir,
        ]) {
            let object = try Self.parsePlist(
                LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app"))
            let environment = try #require(object["EnvironmentVariables"] as? [String: String])

            #expect(environment["OPENCLAW_CONFIG_PATH"] == configPath)
            #expect(environment["OPENCLAW_STATE_DIR"] == stateDir)
            #expect(environment["PATH"]?.isEmpty == false)
        }
    }

    @Test func `launch at login plist omits empty profile environment`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": "   ",
            "OPENCLAW_STATE_DIR": "",
        ]) {
            let object = try Self.parsePlist(
                LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app"))
            let environment = try #require(object["EnvironmentVariables"] as? [String: String])

            #expect(environment["OPENCLAW_CONFIG_PATH"] == nil)
            #expect(environment["OPENCLAW_STATE_DIR"] == nil)
            #expect(environment["PATH"]?.isEmpty == false)
        }
    }

    private static func parsePlist(_ plist: String) throws -> [String: Any] {
        let data = try #require(plist.data(using: .utf8))
        return try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }
}
