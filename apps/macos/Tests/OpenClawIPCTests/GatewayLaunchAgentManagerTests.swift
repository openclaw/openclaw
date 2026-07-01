import Foundation
import Testing
@testable import OpenClaw

struct GatewayLaunchAgentManagerTests {
    @Test func `attach only runtime override does not uninstall gateway launch agent`() throws {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-attach-only-\(UUID().uuidString)", isDirectory: true)
        let marker = dir.appendingPathComponent("disable-launchagent")
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: dir) }
        defer {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
        }

        GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
        GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
        GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

        let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride()

        #expect(error == nil)
        #expect(FileManager().fileExists(atPath: marker.path))
        #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
    }

    @Test func `launch agent plist snapshot parses args and env`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway", "--port", "18789", "--bind", "loopback"],
            "EnvironmentVariables": [
                "OPENCLAW_GATEWAY_TOKEN": " secret ",
                "OPENCLAW_GATEWAY_PASSWORD": "pw",
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.token == "secret")
        #expect(snapshot.password == "pw")
    }

    @Test func `launch agent plist snapshot allows missing bind`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
    }

    @Test func `plist contents preserves profile environment variables`() throws {
        let env = [
            "OPENCLAW_CONFIG_PATH": "/tmp/test-openclaw.json",
            "OPENCLAW_STATE_DIR": "/tmp/test-state",
            "OPENCLAW_PROFILE": "work",
        ]
        let xml = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app", environment: env)
        let data = try #require(xml.data(using: .utf8))
        let root = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let envDict = try #require(root["EnvironmentVariables"] as? [String: String])

        #expect(envDict["OPENCLAW_CONFIG_PATH"] == "/tmp/test-openclaw.json")
        #expect(envDict["OPENCLAW_STATE_DIR"] == "/tmp/test-state")
        #expect(envDict["OPENCLAW_PROFILE"] == "work")
        #expect(envDict["PATH"] != nil)
    }

    @Test func `plist contents omits empty profile environment variables`() throws {
        let env: [String: String] = [:]
        let xml = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app", environment: env)
        let data = try #require(xml.data(using: .utf8))
        let root = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let envDict = try #require(root["EnvironmentVariables"] as? [String: String])

        #expect(envDict["OPENCLAW_CONFIG_PATH"] == nil)
        #expect(envDict["OPENCLAW_STATE_DIR"] == nil)
        #expect(envDict["OPENCLAW_PROFILE"] == nil)
        #expect(envDict["PATH"] != nil)
    }
}
