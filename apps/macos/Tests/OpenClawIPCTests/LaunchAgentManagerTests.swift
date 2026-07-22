import Foundation
import Testing
@testable import OpenClaw

struct LaunchAgentManagerTests {
    @Test func `enabling an already loaded login job only refreshes its plist`() async {
        var persistedBundlePaths: [String] = []
        let reloaded = await LaunchAgentManager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            loaded: true,
            writePlist: { persistedBundlePaths.append($0) })

        #expect(reloaded == false)
        #expect(persistedBundlePaths == ["/Applications/OpenClaw.app"])
    }

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

    // MARK: - Profile environment preservation

    @Test func `plist preserves path and both profile env vars when set`() throws {
        let env: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "OPENCLAW_CONFIG_PATH": "/tmp/custom/openclaw.json",
            "OPENCLAW_STATE_DIR": "/tmp/custom/oc-state",
        ]
        let plist = LaunchAgentManager.plistContents(
            bundlePath: "/Applications/OpenClaw.app",
            environment: env)
        let envDict = try #require(self.extractEnvironment(from: plist))

        #expect(envDict["PATH"] as? String == "/usr/bin:/bin")
        #expect(envDict["OPENCLAW_CONFIG_PATH"] as? String == "/tmp/custom/openclaw.json")
        #expect(envDict["OPENCLAW_STATE_DIR"] as? String == "/tmp/custom/oc-state")
    }

    @Test func `plist omits profile env vars when unset`() throws {
        let env: [String: String] = ["PATH": "/usr/bin:/bin"]
        let plist = LaunchAgentManager.plistContents(
            bundlePath: "/Applications/OpenClaw.app",
            environment: env)
        let envDict = try #require(self.extractEnvironment(from: plist))

        #expect(envDict["PATH"] as? String == "/usr/bin:/bin")
        #expect(envDict["OPENCLAW_CONFIG_PATH"] == nil)
        #expect(envDict["OPENCLAW_STATE_DIR"] == nil)
    }

    @Test func `plist omits profile env vars when empty or whitespace`() throws {
        let env: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "OPENCLAW_CONFIG_PATH": "",
            "OPENCLAW_STATE_DIR": "   ",
        ]
        let plist = LaunchAgentManager.plistContents(
            bundlePath: "/Applications/OpenClaw.app",
            environment: env)
        let envDict = try #require(self.extractEnvironment(from: plist))

        #expect(envDict["PATH"] as? String == "/usr/bin:/bin")
        #expect(envDict["OPENCLAW_CONFIG_PATH"] == nil)
        #expect(envDict["OPENCLAW_STATE_DIR"] == nil)
    }

    @Test func `plist xml escapes special characters in env values`() throws {
        let env: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "OPENCLAW_CONFIG_PATH": "/tmp/foo & bar/co<nfig>o.json",
            "OPENCLAW_STATE_DIR": "/tmp/oc's state\"dir",
        ]
        let plist = LaunchAgentManager.plistContents(
            bundlePath: "/Applications/OpenClaw.app",
            environment: env)
        let envDict = try #require(self.extractEnvironment(from: plist))

        #expect(envDict["OPENCLAW_CONFIG_PATH"] as? String == "/tmp/foo & bar/co<nfig>o.json")
        #expect(envDict["OPENCLAW_STATE_DIR"] as? String == "/tmp/oc's state\"dir")
    }

    // MARK: - Helpers

    private func extractEnvironment(from plist: String) throws -> [String: Any]? {
        guard let data = plist.data(using: .utf8) else { return nil }
        guard let object = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
        return object["EnvironmentVariables"] as? [String: Any]
    }
}
