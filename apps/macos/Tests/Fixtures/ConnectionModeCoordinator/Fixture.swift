import Foundation

/// Compile the actual coordinator with side-effect owners replaced. The window
/// double records presentation lifetime without creating AppKit or app state.
enum AppState {
    enum ConnectionMode { case unconfigured, local, remote }
}

@MainActor
final class AppStateStore {
    static let shared = AppStateStore()
    var hostsLocalGatewayWithRemotePrimary = false
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()
    var primaryWindowOpen = false

    func resetPrimaryConnections() {
        self.primaryWindowOpen = false
    }

    func closeLocalGatewayWindows() {}
}

@MainActor
final class MacGatewayConnectionFleet {
    static let shared = MacGatewayConnectionFleet()
    func disconnectLocal(ifCurrent: () -> Bool) async {
        _ = ifCurrent()
    }
}

@MainActor
final class NodesStore {
    static let shared = NodesStore()
    var lastError: String?
}

@MainActor
enum NodeServiceManager {
    static var starts = 0
    static func stop() async {}
    static func start() async -> String? {
        self.starts += 1
        return nil
    }
}

@MainActor
final class RemoteTunnelManager {
    static let shared = RemoteTunnelManager()
    func stopAll() async {}
}

@MainActor
final class GatewayEndpointStore {
    static let shared = GatewayEndpointStore()
    func ensureRemoteControlTunnel() async throws -> UInt16 {
        18995
    }
}

@MainActor
final class ControlChannel {
    static let shared = ControlChannel()
    var configurations = 0
    func disconnect() async {}
    func configure() async {
        self.configurations += 1
    }
}

@MainActor
final class PortGuardian {
    static let shared = PortGuardian()
    func reapOrphanedTunnels() async {}
}

@MainActor
final class StartupGate {
    private var entry: CheckedContinuation<Void, Never>?
    private var completion: CheckedContinuation<Void, Never>?
    private var entered = false

    func wait() async {
        await withCheckedContinuation { continuation in
            self.completion = continuation
            self.entered = true
            self.entry?.resume()
            self.entry = nil
        }
    }

    func waitUntilEntered() async {
        guard !self.entered else { return }
        await withCheckedContinuation { self.entry = $0 }
    }

    func finish() {
        self.completion?.resume()
        self.completion = nil
    }
}

@MainActor
final class GatewayProcessManager {
    static let shared = GatewayProcessManager()
    var nextStartupGate: StartupGate?

    func clearLastFailure() {}
    func stop() {}
    func setActive(_: Bool) {}
    func ensureLaunchAgentEnabledIfNeeded() async -> Bool {
        true
    }

    func waitForGatewayReady(launchAgentInstalled _: Bool) async -> Bool {
        true
    }

    func waitForStartupAttempt() async {
        let gate = self.nextStartupGate
        self.nextStartupGate = nil
        await gate?.wait()
    }
}

@main
@MainActor
enum ConnectionModeFixture {
    private static var failures = 0

    static func main() async {
        await self.launchChatSurvivesRemoteSetup()
        await self.localChatSurvivesInitialization()
        await self.supersededSetupCannotConfigure()
        if self.failures > 0 { exit(1) }
        print("PASS: ConnectionModeCoordinator headless lifecycle regressions")
    }

    private static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            self.failures += 1
            print("FAIL: \(message)")
        }
    }

    private static func launchChatSurvivesRemoteSetup() async {
        let coordinator = ConnectionModeCoordinator()
        let gate = StartupGate()
        GatewayProcessManager.shared.nextStartupGate = gate
        let apply = Task { await coordinator.apply(mode: .remote, paused: false) }
        await gate.waitUntilEntered()
        // --chat can complete while the launch task is still waiting for the
        // local Gateway stop. Its completion must not retire this presentation.
        WebChatManager.shared.primaryWindowOpen = true
        gate.finish()
        await apply.value
        self.expect(WebChatManager.shared.primaryWindowOpen, "launch chat closed after remote setup settled")

        for (paused, hosting) in [(true, false), (false, false), (false, true)] {
            WebChatManager.shared.primaryWindowOpen = true
            AppStateStore.shared.hostsLocalGatewayWithRemotePrimary = hosting
            await coordinator.apply(mode: .remote, paused: paused)
            self.expect(
                WebChatManager.shared.primaryWindowOpen,
                "same remote selection closed chat (paused=\(paused), hosting=\(hosting))")
        }
        AppStateStore.shared.hostsLocalGatewayWithRemotePrimary = false
    }

    private static func localChatSurvivesInitialization() async {
        WebChatManager.shared.primaryWindowOpen = true
        await ConnectionModeCoordinator().apply(mode: .local, paused: false)
        self.expect(WebChatManager.shared.primaryWindowOpen, "launch chat closed during local initialization")
    }

    private static func supersededSetupCannotConfigure() async {
        let coordinator = ConnectionModeCoordinator()
        let gate = StartupGate()
        GatewayProcessManager.shared.nextStartupGate = gate
        let configurations = ControlChannel.shared.configurations
        let nodeStarts = NodeServiceManager.starts
        let stale = Task { await coordinator.apply(mode: .remote, paused: false) }
        await gate.waitUntilEntered()
        await coordinator.apply(mode: .local, paused: false)
        // The successor's presentation opens before the earlier setup finishes.
        WebChatManager.shared.primaryWindowOpen = true
        gate.finish()
        await stale.value
        self.expect(WebChatManager.shared.primaryWindowOpen, "stale setup closed its successor's chat")
        self.expect(NodeServiceManager.starts == nodeStarts, "stale remote setup started the node")
        self.expect(
            ControlChannel.shared.configurations == configurations + 1,
            "stale setup configured the control channel")
    }
}
