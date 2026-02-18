import Foundation
import Testing
@testable import OpenClaw

@Suite struct GatewayLaunchAgentManagerTests {
    @Test func launchAgentPlistSnapshotParsesArgsAndEnv() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789", "--bind", "loopback"],
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

    @Test func launchAgentPlistSnapshotAllowsMissingBind() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
    }

    @Test func enableCommandPlanSkipsWhenAlreadyLoadedAndConfigMatches() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: ["/usr/local/bin/node", "/path/to/dist/index.js", "gateway", "--port", "18789"],
            environment: [:],
            stdoutPath: nil,
            stderrPath: nil,
            port: 18789,
            bind: nil,
            token: nil,
            password: nil)
        let plan = GatewayLaunchAgentManager.enableCommandPlan(
            isAlreadyLoaded: true,
            snapshot: snapshot,
            desiredPort: 18789,
            desiredRuntime: "node")
        #expect(plan.isEmpty)
    }

    @Test func enableCommandPlanRepairsLoadedServiceWhenPortChanged() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: ["/usr/local/bin/node", "/path/to/dist/index.js", "gateway", "--port", "9999"],
            environment: [:],
            stdoutPath: nil,
            stderrPath: nil,
            port: 9999,
            bind: nil,
            token: nil,
            password: nil)
        let plan = GatewayLaunchAgentManager.enableCommandPlan(
            isAlreadyLoaded: true,
            snapshot: snapshot,
            desiredPort: 18789,
            desiredRuntime: "node")
        #expect(plan.count == 2)
        #expect(plan[0] == ["install", "--port", "18789", "--runtime", "node"])
        #expect(plan[1] == ["install", "--force", "--port", "18789", "--runtime", "node"])
    }

    @Test func enableCommandPlanRepairsUnloadedServiceWhenPlistIsStale() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: ["/usr/local/bin/node", "/path/to/dist/index.js", "gateway", "--port", "9999"],
            environment: [:],
            stdoutPath: nil,
            stderrPath: nil,
            port: 9999,
            bind: nil,
            token: nil,
            password: nil)
        let plan = GatewayLaunchAgentManager.enableCommandPlan(
            isAlreadyLoaded: false,
            snapshot: snapshot,
            desiredPort: 18789,
            desiredRuntime: "node")
        #expect(plan.count == 2)
        #expect(plan[0] == ["install", "--port", "18789", "--runtime", "node"])
        #expect(plan[1] == ["install", "--force", "--port", "18789", "--runtime", "node"])
    }

    @Test func enableCommandPlanPrefersStartThenInstallThenForceInstall() {
        let plan = GatewayLaunchAgentManager.enableCommandPlan(
            isAlreadyLoaded: false,
            desiredPort: 18789,
            desiredRuntime: "node")
        #expect(plan.count == 3)
        #expect(plan[0] == ["start"])
        #expect(plan[1] == ["install", "--port", "18789", "--runtime", "node"])
        #expect(plan[2] == ["install", "--force", "--port", "18789", "--runtime", "node"])
    }

    @Test func terminalSuccessTreatsStartNotLoadedAsNonTerminal() {
        let shouldStop = GatewayLaunchAgentManager.isTerminalEnableSuccess(
            command: ["start"],
            success: true,
            daemonResult: "not-loaded")
        #expect(shouldStop == false)
    }

    @Test func terminalSuccessTreatsInstallAlreadyInstalledAsNonTerminal() {
        let shouldStop = GatewayLaunchAgentManager.isTerminalEnableSuccess(
            command: ["install", "--port", "18789", "--runtime", "node"],
            success: true,
            daemonResult: "already-installed")
        #expect(shouldStop == false)
    }

    @Test func terminalSuccessTreatsForceInstallAsTerminal() {
        let shouldStop = GatewayLaunchAgentManager.isTerminalEnableSuccess(
            command: ["install", "--force", "--port", "18789", "--runtime", "node"],
            success: true,
            daemonResult: "already-installed")
        #expect(shouldStop == true)
    }

    @Test func nonTerminalSuccessRecognizesExpectedContinueSignals() {
        let startNonTerminal = GatewayLaunchAgentManager.isNonTerminalSuccessfulStep(
            command: ["start"],
            success: true,
            daemonResult: "not-loaded")
        #expect(startNonTerminal == true)

        let installNonTerminal = GatewayLaunchAgentManager.isNonTerminalSuccessfulStep(
            command: ["install", "--port", "18789", "--runtime", "node"],
            success: true,
            daemonResult: "already-installed")
        #expect(installNonTerminal == true)
    }
}
