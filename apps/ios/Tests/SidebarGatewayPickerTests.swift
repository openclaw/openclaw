import Foundation
import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

struct SidebarGatewayPickerTests {
    static func entry(_ id: String, name: String? = nil) -> GatewaySettingsStore.GatewayRegistryEntry {
        .init(
            stableID: id,
            kind: .manual,
            name: name ?? id,
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            lastConnectedAtMs: nil)
    }

    @Test(arguments: [0, 1, 2, 4])
    func `visibility counts saved gateways even when none are online`(count: Int) {
        let entries = (0..<count).map { Self.entry("gateway-\($0)") }
        let presentation = SidebarGatewayPresentation(
            registry: .init(connectedStableIDs: [], entries: entries),
            connectionID: nil,
            connectedID: nil,
            state: .disconnected)

        #expect(presentation.showsPicker == (count > 1))
        #expect(presentation.entries == entries)
    }

    @Test func `pending saved selection cannot relabel the still active route`() {
        let a = Self.entry("gateway-a", name: "Studio")
        let b = Self.entry("gateway-b", name: "Home")
        let registry = GatewaySettingsStore.GatewayRegistry(activeStableID: b.stableID, entries: [a, b])
        let beforeHandoff = SidebarGatewayPresentation(
            registry: registry,
            connectionID: a.stableID,
            connectedID: a.stableID,
            state: .connected)
        let afterHandoff = SidebarGatewayPresentation(
            registry: registry,
            connectionID: b.stableID,
            connectedID: b.stableID,
            state: .connecting)

        #expect(beforeHandoff.focusedEntry == a)
        #expect(afterHandoff.focusedEntry == b)
        #expect(beforeHandoff.rowSubtitle(a) == "Online")
        #expect(beforeHandoff.rowSubtitle(b) == nil)
        #expect(afterHandoff.rowSubtitle(b) == "Connecting")
    }

    @Test func `legacy addresses keep just enough information to identify each connection`() {
        func endpoint(_ host: String, _ port: Int) -> GatewaySettingsStore.GatewayRegistryEntry {
            .init(
                stableID: "\(host):\(port)",
                kind: .manual,
                name: "\(host):\(port)",
                host: host,
                port: port,
                useTLS: true,
                lastConnectedAtMs: nil)
        }
        let studio = endpoint("tidal-vireo.example.net", 8448)
        var test = endpoint("tidal-vireo.example.net", 8449)
        let home = endpoint("192.0.2.2", 443)
        var registry = GatewaySettingsStore.GatewayRegistry(entries: [studio, test, home])
        #expect(studio.displayName == "tidal-vireo")
        #expect(registry.compactName(for: studio) == "tidal-vireo:8448")
        #expect(registry.distinguishingAddress(for: test) == "Port 8449")
        #expect(home.displayName == "192.0.2.2")
        #expect(registry.distinguishingAddress(for: home) == nil)
        test.name = "Sandbox"
        registry.entries = [studio, test, home]
        #expect(test.displayName == "Sandbox")
        #expect(registry.compactName(for: studio) == "tidal-vireo")
        #expect(registry.distinguishingAddress(for: studio) == nil)
    }

    @Test func `offline cold open uses saved focus without claiming it is online`() {
        let entry = Self.entry("gateway-a", name: "Studio")
        let presentation = SidebarGatewayPresentation(
            registry: .init(activeStableID: entry.stableID, connectedStableIDs: [entry.stableID], entries: [entry]),
            connectionID: nil,
            connectedID: nil,
            state: .disconnected)

        #expect(presentation.focusedEntry == entry)
        #expect(presentation.rowSubtitle(entry) == "Offline")
        #expect(!presentation.showsPicker)
    }

    @Test func `connected owner wins over a persisted selection without a config`() {
        let presentation = SidebarGatewayPresentation(
            registry: .init(activeStableID: "pending", entries: [Self.entry("pending"), Self.entry("current")]),
            connectionID: nil,
            connectedID: "current",
            state: .error)

        #expect(presentation.focusedID == "current")
        #expect(presentation.rowSubtitle(Self.entry("current")) == "Needs attention")
    }

    @Test func `the control shows the green dot only when online, and speaks every state`() {
        func status(_ state: GatewayDisplayState, problem: String? = nil, switching: Bool = false) -> String {
            SidebarGatewayPresentation(
                registry: .init(activeStableID: "a", entries: [Self.entry("a")]),
                connectionID: nil,
                connectedID: nil,
                state: state,
                problemText: problem).accessibilityStatus(isSwitching: switching)
        }

        #expect(status(.connected) == "Online")
        #expect(status(.connected, switching: true) == "Connecting")
        #expect(status(.connecting) == "Connecting")
        #expect(status(.disconnected) == "Offline")
        #expect(status(.error, problem: "Connection refused") == "Connection refused")
        #expect(status(.error) == "Needs attention")
        let unsaved = SidebarGatewayPresentation(
            registry: .empty, connectionID: nil, connectedID: nil, state: .disconnected)
        #expect(unsaved.accessibilityStatus(isSwitching: false).isEmpty)

        func dot(_ state: GatewayDisplayState, switching: Bool = false) -> Bool {
            SidebarGatewayPresentation(
                registry: .init(activeStableID: "a", entries: [Self.entry("a")]),
                connectionID: nil,
                connectedID: nil,
                state: state).showsOnlineDot(isSwitching: switching)
        }

        #expect(dot(.connected))
        #expect(!dot(.connected, switching: true))
        #expect(!dot(.connecting))
        #expect(!dot(.disconnected))
        #expect(!dot(.error))
        let unsavedOnline = SidebarGatewayPresentation(
            registry: .empty, connectionID: nil, connectedID: nil, state: .connected)
        #expect(!unsavedOnline.showsOnlineDot(isSwitching: false))
    }

    @Test func `an unknown route does not select another saved gateway`() {
        let presentation = SidebarGatewayPresentation(
            registry: .init(activeStableID: "saved", entries: [Self.entry("saved"), Self.entry("other")]),
            connectionID: "unknown-route",
            connectedID: nil,
            state: .connected)

        #expect(presentation.showsPicker)
        #expect(presentation.focusedID == "unknown-route")
        #expect(presentation.focusedEntry == nil)
    }

    @Test @MainActor func `gateway control renders saved counts across size and color settings`() {
        for count in [0, 1, 3] {
            let entries = (0..<count).map {
                Self.entry("gateway-\($0)", name: "A long saved Gateway name for a remote studio \($0)")
            }
            for scheme in [ColorScheme.light, .dark] {
                for typeSize in [DynamicTypeSize.large, .accessibility3] {
                    let presentation = SidebarGatewayPresentation(
                        registry: .init(activeStableID: entries.first?.stableID, entries: entries),
                        connectionID: nil,
                        connectedID: nil,
                        state: .disconnected)
                    let root = SidebarGatewayPicker(
                        presentation: presentation,
                        fallbackName: "Connection",
                        isSwitching: false,
                        selectGateway: { _ in },
                        openSettings: {})
                        .environment(\.dynamicTypeSize, typeSize)
                        .preferredColorScheme(scheme)
                    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 280, height: 300))
                    window.rootViewController = UIHostingController(rootView: root)
                    window.makeKeyAndVisible()
                    window.rootViewController?.view.layoutIfNeeded()
                    #expect(window.rootViewController?.view.bounds.width == 280)
                    window.isHidden = true
                }
            }
        }
    }

    @Test func `a failed switch names the cause in plain words and keeps transport terms out`() {
        func toast(_ message: String, _ kind: GatewayConnectionProblem.Kind? = nil) -> (String, Bool) {
            let toast = GatewaySwitchFailureToast(message: message, problemKind: kind, hostName: "Studio")
            return (toast.text, toast.offersRetry)
        }

        #expect(toast("anything", .reachabilityFailed) == ("Couldn’t reach Studio.", true))
        #expect(toast("anything", .connectionRefused) == ("Couldn’t reach Studio.", true))
        #expect(toast("Failed to resolve the discovered gateway endpoint.") == ("Couldn’t reach Studio.", true))
        #expect(toast("Failed to build discovered gateway URL.")
            == ("Couldn’t connect. Check this host’s address.", false))
        #expect(toast("A TLS certificate fingerprint requires a secure gateway URL.")
            == ("Studio needs a secure connection.", false))
        #expect(toast("anything", .tlsCertificateUnavailable) == ("Studio needs a secure connection.", false))
        #expect(toast("anything", .tlsPinMismatch) == ("Studio isn’t the host you paired with.", false))
        #expect(toast("This host isn’t available anymore.") == ("This host isn’t available anymore.", false))
        #expect(toast("Couldn’t switch hosts.") == ("Couldn’t switch hosts.", true))
        #expect(toast("Couldn’t find Studio on this network.") == ("Couldn’t find Studio on this network.", true))
        #expect(toast("Missing instanceId (node.instanceId). Try restarting the app.")
            == ("Couldn’t connect to Studio.", true))
    }

    @Test func `a host without a saved name gets sentences that read correctly`() {
        func toast(_ message: String, _ kind: GatewayConnectionProblem.Kind? = nil) -> String {
            GatewaySwitchFailureToast(message: message, problemKind: kind, hostName: nil).text
        }

        #expect(toast("anything", .tlsCertificateUnavailable) == "This host needs a secure connection.")
        #expect(toast("anything", .tlsPinMismatch) == "This isn’t the host you paired with.")
        #expect(toast("anything", .reachabilityFailed) == "Couldn’t reach this host.")
        #expect(toast("Couldn’t find this host on this network.") == "Couldn’t find this host on this network.")
        #expect(toast("Missing instanceId (node.instanceId). Try restarting the app.") ==
            "Couldn’t connect to this host.")
    }
}
