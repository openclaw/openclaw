import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct LaunchAgentManagerTests {
    @Test func `launch at login plist does not keep app alive after manual quit`() throws {
        let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
        let data = try #require(plist.data(using: .utf8))
        let object = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        #expect(object["RunAtLoad"] as? Bool == true)
        #expect(object["KeepAlive"] == nil)

        let args = try #require(object["ProgramArguments"] as? [String])
        #expect(args == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
    }

    @Test @MainActor func `launch at login plist preserves config path environment`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-login-agent-\(UUID().uuidString)", isDirectory: true)
        let configPath = root.appendingPathComponent("custom & config.json").path
        let stateDir = root.appendingPathComponent("state & dir", isDirectory: true).path
        defer { try? FileManager().removeItem(at: root) }

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_STATE_DIR": stateDir,
        ]) {
            let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/Open&Claw.app")
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let args = try #require(object["ProgramArguments"] as? [String])
            #expect(args == ["/Applications/Open&Claw.app/Contents/MacOS/OpenClaw"])

            let env = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(env["OPENCLAW_CONFIG_PATH"] == configPath)
            #expect(env["OPENCLAW_STATE_DIR"] == stateDir)
            #expect(env["PATH"]?.isEmpty == false)
        }
    }

    @Test @MainActor func `launch at login plist omits empty config path environment`() async throws {
        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": "   ",
            "OPENCLAW_STATE_DIR": "",
        ]) {
            let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            let env = try #require(object["EnvironmentVariables"] as? [String: String])

            #expect(env["OPENCLAW_CONFIG_PATH"] == nil)
            #expect(env["OPENCLAW_STATE_DIR"] == nil)
            #expect(env["PATH"]?.isEmpty == false)
        }
    }
}
