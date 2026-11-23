import AppKit
import OpenClawDiscovery
import OpenClawKit
import SwiftUI
import Synchronization
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct LocalNetworkDiscoveryTests {
    /// Rendered only in the disposable macOS runner or an OS sandbox, never on the operator desktop.
    @Test func `local setup never browses the network until Nearby is chosen`() async throws {
        try await AppKitTestSupport.startApplication()
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let suite = "LocalNetworkDiscoveryTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": root.appendingPathComponent("openclaw.json").path,
        ]) {
            // Starting discovery resolves this Mac's identity first; inactive discovery never reads it.
            let discoveryStarts = Mutex(0)
            let discovery = GatewayDiscoveryModel(
                localDisplayName: discoveryStarts.withLock { starts in
                    starts += 1
                    return "Test Mac"
                },
                filterLocalGateways: false)
            let gatewayURL = try #require(URL(string: "wss://unused.example.test"))
            let connection = GatewayConnection(
                configProvider: { (url: gatewayURL, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()))
            let state = AppState(preview: true)
            state.onboardingSeen = false
            state.connectionMode = .unconfigured
            let view = OnboardingView(
                initialPage: .connection,
                state: state,
                discoveryModel: discovery,
                aiSetupGateway: connection,
                systemAgentDefaults: defaults,
                gatewaySelectionPersister: { true },
                dashboardHandoffOpener: { _ in })
            let hosting = NSHostingView(rootView: view)
            hosting.frame = NSRect(x: 0, y: 0, width: OnboardingView.windowWidth, height: OnboardingView.windowHeight)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            window.orderFront(nil)
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
                discovery.stop()
            }

            // The recommended local choice checks this Mac's port without browsing the network.
            _ = try await Self.button("On this Mac", in: window)
            try await Task.sleep(for: .milliseconds(500))
            #expect(discoveryStarts.withLock { $0 } == 0)

            // Choosing another computer alone still leaves the network untouched.
            try await Self.press("On another computer", in: window)
            try await Self.press("Next", in: window)
            _ = try await Self.button("Nearby", in: window)
            try await Task.sleep(for: .milliseconds(500))
            #expect(discoveryStarts.withLock { $0 } == 0)

            // Nearby is the choice that needs Local Network access.
            try await Self.press("Nearby", in: window)
            try await TestWait.state("Nearby starts discovery") { discoveryStarts.withLock { $0 } == 1 }

            try await Self.press("Nearby", in: window)
            try await TestWait.observed("closing Nearby stops discovery") {
                discovery.statusText == GatewayDiscoveryStatusText.stopped
            }
            await connection.shutdown()
        }
    }

    /// Rendered only in the disposable macOS runner or an OS sandbox, never on the operator desktop.
    @Test func `connection window browses only while Remote shows Nearby Gateways`() async throws {
        try await AppKitTestSupport.startApplication()
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": root.appendingPathComponent("openclaw.json").path,
        ]) {
            let discoveryStarts = Mutex(0)
            let discovery = GatewayDiscoveryModel(localDisplayName: discoveryStarts.withLock { starts in
                starts += 1
                return "Test Mac"
            })
            let state = AppState(preview: true)
            state.connectionMode = .unconfigured
            let hosting = NSHostingView(rootView: ConnectionSettingsView(state: state, gatewayDiscovery: discovery))
            hosting.frame = NSRect(x: 0, y: 0, width: 640, height: 720)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            window.orderFront(nil)
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
                discovery.stop()
            }
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(500))
            #expect(discoveryStarts.withLock { $0 } == 0)

            state.connectionMode = .remote
            try await TestWait.state("Remote starts discovery") { discoveryStarts.withLock { $0 } == 1 }

            state.connectionMode = .unconfigured
            try await TestWait.observed("leaving Remote stops discovery") {
                discovery.statusText == GatewayDiscoveryStatusText.stopped
            }
        }
    }

    private static func button(_ title: String, in window: NSWindow) async throws -> AnyObject {
        try await AppKitTestSupport.waitForAccessibilityElement(in: window, description: "\(title) button") {
            $0.first { element in
                element.accessibilityRole?() == .button && element.isAccessibilityEnabled?() == true &&
                    [element.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: element)]
                    .compactMap(\.self).contains { $0.hasPrefix(title) }
            }
        }
    }

    private static func press(_ title: String, in window: NSWindow) async throws {
        let button = try await self.button(title, in: window)
        try #require(button.accessibilityPerformPress?() == true, "AX press failed: \(title)")
    }
}
