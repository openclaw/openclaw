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

    @Test func `launch agent plist snapshot reads generated env file`() throws {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-env-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: dir) }

        let envFilePath = dir.appendingPathComponent("ai.openclaw.gateway.env")
        let wrapperPath = dir.appendingPathComponent("ai.openclaw.gateway-env-wrapper.sh")
        try """
        export OPENCLAW_GATEWAY_TOKEN=' secret-from-file '
        export OPENCLAW_GATEWAY_PASSWORD='pw-from-file'
        """.write(to: envFilePath, atomically: true, encoding: .utf8)

        let plistURL = dir.appendingPathComponent("ai.openclaw.gateway.plist")
        let plist: [String: Any] = [
            "ProgramArguments": [
                "/bin/sh",
                wrapperPath.path,
                envFilePath.path,
                "openclaw",
                "gateway",
                "--port",
                "18789",
                "--bind",
                "loopback",
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: [.atomic])

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: plistURL))
        #expect(snapshot.programArguments == ["openclaw", "gateway", "--port", "18789", "--bind", "loopback"])
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.token == "secret-from-file")
        #expect(snapshot.password == "pw-from-file")
        #expect(snapshot.environment["OPENCLAW_GATEWAY_TOKEN"] == "secret-from-file")
    }
}
