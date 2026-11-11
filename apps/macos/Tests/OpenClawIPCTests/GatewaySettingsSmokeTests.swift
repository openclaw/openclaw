import AppKit
import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct GatewaySettingsSmokeTests {
    @Test(arguments: [false, true])
    func `existing Gateway onboarding defers the primary through sign-in cancellation`(
        automaticLocal: Bool) async throws
    {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = root.appendingPathComponent("openclaw.json")
        let original = Data((automaticLocal ? #"{"gateway":{"mode":"local"}}"# : "{}").utf8)
        try original.write(to: config)
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [connectionModeKey: nil, primaryGatewayDeferredFingerprintKey: nil, onboardingSeenKey: false])
        {
            let oldID = GatewayDiscoveryPreferences.preferredStableID()
            let oldBinding = GatewayDiscoveryPreferences.preferredRouteBinding()
            defer { GatewayDiscoveryPreferences.setPreferredStableID(oldID, routeBinding: oldBinding) }
            let state = AppState(preview: true)
            try #require(state.connectionMode == (automaticLocal ? .local : .unconfigured))
            state._testEnableGatewayConfigSync()
            let gateway = GatewayConnection(testEndpointProvider: { throw CancellationError() })
            let discovery = GatewayDiscoveryModel(localDisplayName: "Onboarding fixture", filterLocalGateways: false)
            let view = OnboardingView(
                initialPage: .connection, state: state, discoveryModel: discovery, aiSetupGateway: gateway)
            defer {
                discovery.stop()
                view.configuredGatewayProbe.invalidate()
                view.aiSetup.resetForGatewayChange(clearPendingHandoff: false)
            }
            do {
                try await withHostedSettings(view.environment(\.locale, Locale(identifier: "en_US"))) { _, window in
                    try await pressGatewayButton("Connect to an existing Gateway", in: window)
                    try await TestWait.state("connect-only onboarding sheet") { window.attachedSheet != nil }
                    try #require(state.connectionMode == .unconfigured)
                    #expect(state.syncGatewayConfigNow())
                    state.applyConfigOverrides(OpenClawConfigFile.loadDict())
                    #expect(state.connectionMode == .unconfigured)
                    #expect(try Data(contentsOf: config) == original)

                    let sheet = try #require(window.attachedSheet)
                    try await pressGatewayButton("Cancel", in: sheet)
                    try await TestWait.state("existing Gateway sheet dismissal") { window.attachedSheet == nil }
                    #expect(state.connectionMode == .unconfigured)
                    #expect(!state.onboardingSeen)

                    try await pressGatewayButton("On this Mac", in: window)
                    try await TestWait.state("explicit local selection") { state.connectionMode == .local }
                    await state._testAwaitGatewayConfigSync()
                }
                await gateway.shutdown()
            } catch {
                await gateway.shutdown()
                throw error
            }
        }
    }

    @Test func `first Reconnect prefills the Gateway and Add starts a fresh empty editor`() async throws {
        try await TestIsolation.withIsolatedState {
            let profile = try MacGatewayProfile(
                id: "editor-fixture",
                name: "Project Gateway",
                url: #require(URL(string: "wss://gateway.example.test:8443/control/")))
            try await withHostedSettings(GatewaySettings(profiles: [profile])) { hosting, window in
                var requestOrdinal = 0
                for (action, reconnecting) in [("Reconnect", true), ("Add Gateway", false)] {
                    requestOrdinal += 1
                    let buttons = try await AppKitTestSupport.accessibilityElements(
                        in: hosting,
                        diagnosticContext: "action=\(action) phase=buttons request=\(requestOrdinal)")
                    let button = try #require(buttons.first {
                        $0.accessibilityRole?() == .button &&
                            [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].contains(action)
                    })
                    #expect(button.accessibilityPerformPress?() == true)
                    try await TestWait.state("\(action) sheet") { window.attachedSheet != nil }
                    let sheet = try #require(window.attachedSheet?.contentView)
                    var values: [String] = []
                    var connectEnabled: Bool?
                    try await TestWait.state("\(action) sheet fields") {
                        sheet.layoutSubtreeIfNeeded()
                        requestOrdinal += 1
                        let elements = try await AppKitTestSupport.accessibilityElements(
                            in: sheet,
                            diagnosticContext: "action=\(action) phase=fields request=\(requestOrdinal)")
                        values = elements.filter { $0.accessibilityRole?() == .textField }.map {
                            let value: Any? = $0.accessibilityValue?()
                            return value as? String ?? ""
                        }
                        let submitAction = reconnecting ? "Reconnect" : "Connect"
                        connectEnabled = elements.first {
                            $0.accessibilityRole?() == .button &&
                                [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)]
                                .contains(submitAction)
                        }?.isAccessibilityEnabled?()
                        let populated = values.contains(profile.name) && values.contains(profile.url.absoluteString)
                        return values.count >= 2 && connectEnabled == reconnecting &&
                            (reconnecting ? populated : values.allSatisfy(\.isEmpty))
                    }
                    #expect(values.count >= 2)
                    #expect(connectEnabled == reconnecting)
                    if reconnecting {
                        #expect(values.contains(profile.name))
                        #expect(values.contains(profile.url.absoluteString))
                    } else {
                        let hasOnlyEmptyFields = values.allSatisfy(\.isEmpty)
                        #expect(hasOnlyEmptyFields)
                    }
                    requestOrdinal += 1
                    let cancel = try #require(try await AppKitTestSupport.accessibilityElements(
                        in: sheet,
                        diagnosticContext: "action=\(action) phase=Cancel request=\(requestOrdinal)").first {
                        $0.accessibilityRole?() == .button &&
                            [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].contains("Cancel")
                    })
                    #expect(cancel.accessibilityPerformPress?() == true)
                    try await TestWait.state("\(action) sheet dismissal") { window.attachedSheet == nil }
                }
            }
        }
    }
}

@MainActor
private func withHostedSettings<Content: View>(
    _ view: Content,
    _ body: (NSHostingView<Content>, NSWindow) async throws -> Void) async throws
{
    _ = AppKitTestSupport.application
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer {
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }
    window.orderFront(nil)
    hosting.layoutSubtreeIfNeeded()
    try await body(hosting, window)
}

@MainActor
private func pressGatewayButton(_ title: String, in window: NSWindow) async throws {
    let button = try await AppKitTestSupport.waitForAccessibilityElement(in: window, description: title) { elements in
        elements.first {
            $0.accessibilityRole?() == .button && $0.isAccessibilityEnabled?() == true &&
                AppKitTestSupport.accessibilityName(of: $0)?.contains(title) == true
        }
    }
    try #require(button.accessibilityPerformPress?() == true)
}
