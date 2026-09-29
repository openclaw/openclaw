import AppKit
import Foundation
import SwiftUI

enum DebugActions {
    private static let verboseDefaultsKey = "openclaw.debug.verboseMain"
    private static let onboardingSeenKey = "openclaw.onboardingSeen"

    @MainActor
    static func openAgentEventsWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Agent Events"
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.contentView = NSHostingView(rootView: AgentEventsWindow())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    static func openLog() {
        let path = self.pinoLogPath()
        let url = URL(fileURLWithPath: path)
        guard FileManager().fileExists(atPath: path) else {
            let alert = NSAlert()
            alert.messageText = "Log file not found"
            alert.informativeText = path
            alert.runModal()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @MainActor
    static func openConfigFolder() {
        let url = OpenClawPaths.stateDirURL
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @MainActor
    static func openSessionStore() {
        if AppStateStore.shared.connectionMode == .remote {
            let alert = NSAlert()
            alert.messageText = "Remote mode"
            alert.informativeText = "Session store lives on the gateway host in remote mode."
            alert.runModal()
            return
        }
        let path = self.resolveSessionStorePath()
        let url = URL(fileURLWithPath: path)
        if FileManager().fileExists(atPath: path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }

    static func sendTestNotification() async -> TestNotificationOutcome {
        await TestNotificationAction.send()
    }

    static func sendDebugVoice() async -> Result<String, DebugActionError> {
        let message = """
        This is a debug test from the Mac app. Reply with "Debug test works (and a funny pun)" \
        if you received that.
        """
        let result = await VoiceWakeForwarder.forward(transcript: message)
        switch result {
        case .success:
            return .success("Sent. Await reply.")
        case let .failure(error):
            let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(.message("Send failed: \(detail)"))
        }
    }

    static func restartGateway() {
        Task { @MainActor in
            let state = AppStateStore.shared
            guard state.connectionMode == .local else { return }
            let generation = state.gatewayRoutingGeneration
            let endpointRevision = GatewayEndpointStore.shared.routeRevision
            GatewayProcessManager.shared.stop()
            await GatewayConnection.shared.shutdown(ifCurrent: {
                !Task.isCancelled && GatewayEndpointStore.shared.routeRevision == endpointRevision
            })
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, state.connectionMode == .local,
                  state.gatewayRoutingGeneration == generation else { return }
            GatewayProcessManager.shared.setActive(true)
            await ControlChannel.shared.configure()
            guard !Task.isCancelled, state.gatewayRoutingGeneration == generation else { return }
            await HealthStore.shared.refresh(onDemand: true)
        }
    }

    @MainActor
    static func resetGatewayTunnel() async -> Result<String, DebugActionError> {
        let root = OpenClawConfigFile.loadDict()
        guard ConnectionModeResolver.resolve(root: root).mode == .remote,
              GatewayRemoteConfig.resolveTransport(root: root) == .ssh
        else {
            return .failure(.message("Remote SSH transport is not enabled."))
        }
        let state = AppStateStore.shared
        let generation = state.gatewayRoutingGeneration
        let endpointRevision = GatewayEndpointStore.shared.routeRevision
        func requireCurrentRoute() throws {
            try Task.checkCancellation()
            guard state.gatewayRoutingGeneration == generation,
                  state.connectionMode == .remote, state.remoteTransport == .ssh
            else { throw CancellationError() }
        }
        do {
            try requireCurrentRoute()
            await RemoteTunnelManager.shared.stopAll(ifCurrent: {
                !Task.isCancelled && GatewayEndpointStore.shared.routeRevision == endpointRevision
            })
            try requireCurrentRoute()
            await GatewayConnection.shared.shutdown(ifCurrent: {
                !Task.isCancelled && GatewayEndpointStore.shared.routeRevision == endpointRevision
            })
            try requireCurrentRoute()
            _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
            try requireCurrentRoute()
            await ControlChannel.shared.configure()
            try requireCurrentRoute()
            await HealthStore.shared.refresh(onDemand: true)
            try requireCurrentRoute()
            return .success("SSH tunnel reset.")
        } catch is CancellationError {
            return .failure(.message("SSH tunnel reset was superseded or canceled."))
        } catch {
            do {
                try requireCurrentRoute()
                await HealthStore.shared.refresh(onDemand: true)
                try requireCurrentRoute()
            } catch {
                return .failure(.message("SSH tunnel reset was superseded or canceled."))
            }
            return .failure(.message(error.localizedDescription))
        }
    }

    static func pinoLogPath() -> String {
        LogLocator.bestLogFile()?.path ?? LogLocator.launchdLogPath
    }

    @MainActor
    static func runHealthCheckNow() async {
        await HealthStore.shared.refresh(onDemand: true)
    }

    static func sendTestHeartbeat() async -> Result<ControlHeartbeatEvent?, Error> {
        do {
            _ = await GatewayConnection.shared.setHeartbeatsEnabled(true)
            await ControlChannel.shared.configure()
            let data = try await ControlChannel.shared.request(method: "last-heartbeat")
            if let evt = try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data) {
                return .success(evt)
            }
            return .success(nil)
        } catch {
            return .failure(error)
        }
    }

    static var verboseLoggingEnabledMain: Bool {
        AppDefaults.standard.bool(forKey: self.verboseDefaultsKey)
    }

    static func toggleVerboseLoggingMain() async -> Bool {
        let newValue = !self.verboseLoggingEnabledMain
        AppDefaults.standard.set(newValue, forKey: self.verboseDefaultsKey)
        _ = try? await ControlChannel.shared.request(
            method: "system-event",
            params: ["text": AnyHashable("verbose-main:\(newValue ? "on" : "off")")])
        return newValue
    }

    @MainActor
    static func restartApp() {
        let url = Bundle.main.bundleURL
        let task = Process()
        // The replacement must wait until cleanup releases this profile's instance lock.
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = [
            "-c",
            "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.1; done; shift; exec /usr/bin/open -n \"$@\"",
            "openclaw-restart",
            String(ProcessInfo.processInfo.processIdentifier),
        ] + (AppProfile.current.name.map { ["--env", "OPENCLAW_PROFILE=\($0)"] } ?? []) + [url.path]
        try? task.run()
        AppDelegate.requestTermination()
    }

    @MainActor
    static func restartOnboarding() {
        AppDefaults.standard.set(false, forKey: self.onboardingSeenKey)
        AppDefaults.standard.set(0, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = false
        OnboardingController.shared.restart()
    }

    @MainActor
    private static func resolveSessionStorePath() -> String {
        let defaultPath = SessionLoader.defaultStorePath
        let configURL = OpenClawPaths.configURL
        guard
            let data = try? Data(contentsOf: configURL),
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let session = parsed["session"] as? [String: Any],
            let path = session["store"] as? String,
            !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return defaultPath
        }
        return path
    }

    // MARK: - Port diagnostics

    typealias PortListener = PortGuardian.ReportListener
    typealias PortReport = PortGuardian.PortReport

    @MainActor
    static func checkGatewayPorts() async -> [PortReport] {
        let mode = CommandResolver.connectionSettings().mode
        let hostsLocalGateway = AppStateStore.shared.hostsLocalGatewayWithRemotePrimary
        let tunnel = await RemoteTunnelManager.shared.controlTunnelStatus()
        return await PortGuardian.shared.diagnose(
            mode: mode,
            activeTunnelPort: tunnel.localPort,
            hostsLocalGateway: hostsLocalGateway)
    }

    static func killProcess(_ pid: Int) async -> Result<Void, DebugActionError> {
        let primary = await ShellExecutor.run(command: ["kill", "-TERM", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if primary.ok { return .success(()) }
        let force = await ShellExecutor.run(command: ["kill", "-KILL", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if force.ok { return .success(()) }
        let detail = force.message ?? primary.message ?? "kill failed"
        return .failure(.message(detail))
    }

    #if DEBUG
    @MainActor
    static func showPairingPanelDemo() {
        let now = Date()
        PairingApprovalCenter.shared.injectDemoCards([
            PairingApprovalCenter.Card(
                kind: .node,
                requestId: "demo-node-1",
                subjectId: "19cec1c3301a7469d4fd71f5f81339508390dadda91b34aee15faf2849dccdc7",
                displayName: "Demo Mac",
                platform: "macos 26.5",
                deviceFamily: "Mac",
                modelIdentifier: "MacBookPro18,3",
                version: "2026.6.11",
                coreVersion: "2026.6.10",
                remoteIp: "192.0.2.42",
                role: nil,
                scopes: [],
                caps: [
                    "canvas",
                    "screen",
                    "computer",
                    "codex-app-server-threads",
                    "claude-sessions",
                    "browser",
                    "codex-cli-sessions",
                    "file",
                    "local-inference",
                    "mcp",
                    "opencode-sessions",
                    "pi-sessions",
                    "system",
                ],
                commands: ["system.run", "system.notify"],
                isRepair: false,
                previouslyPaired: false,
                requestedAt: now.addingTimeInterval(-45),
                requiredApproveScopes: ["operator.pairing", "operator.admin"]),
            PairingApprovalCenter.Card(
                kind: .node,
                requestId: "demo-admin-node",
                subjectId: "demo-admin-node",
                displayName: "Browser node",
                platform: "linux",
                deviceFamily: nil,
                modelIdentifier: nil,
                version: nil,
                coreVersion: nil,
                remoteIp: "192.0.2.43",
                role: nil,
                scopes: [],
                caps: ["browser", "file"],
                commands: ["browser.proxy", "fs.listDir", "terminal.upload", "system.execApprovals.get"],
                isRepair: false,
                previouslyPaired: false,
                requestedAt: now,
                requiredApproveScopes: ["operator.pairing", "operator.admin"]),
            PairingApprovalCenter.Card(
                kind: .device,
                requestId: "demo-device-1",
                subjectId: "4a865684dbfa7b7937bd333813476ca88b672c2d02ad08fc52b80d88af4e82bd",
                displayName: "OpenClaw iPhone",
                platform: "ios 26.4",
                deviceFamily: nil,
                modelIdentifier: nil,
                version: nil,
                coreVersion: nil,
                remoteIp: "192.168.1.87",
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.approvals"],
                caps: [],
                commands: [],
                isRepair: true,
                previouslyPaired: true,
                requestedAt: now.addingTimeInterval(-190)),
        ])
    }
    #endif
}

enum DebugActionError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case let .message(text):
            text
        }
    }
}
