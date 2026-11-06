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
        #expect(beforeHandoff.rowTitle(a) == "Studio — Online")
        #expect(beforeHandoff.rowTitle(b) == "Home")
        #expect(afterHandoff.rowTitle(b) == "Home — Connecting")
    }

    @Test func `offline cold open uses saved focus without claiming it is online`() {
        let entry = Self.entry("gateway-a", name: "Studio")
        let presentation = SidebarGatewayPresentation(
            registry: .init(activeStableID: entry.stableID, connectedStableIDs: [entry.stableID], entries: [entry]),
            connectionID: nil,
            connectedID: nil,
            state: .disconnected)

        #expect(presentation.focusedEntry == entry)
        #expect(presentation.rowTitle(entry) == "Studio — Offline")
        #expect(!presentation.showsPicker)
    }

    @Test func `connected owner wins over a persisted selection without a config`() {
        let presentation = SidebarGatewayPresentation(
            registry: .init(activeStableID: "pending", entries: [Self.entry("pending"), Self.entry("current")]),
            connectionID: nil,
            connectedID: "current",
            state: .error)

        #expect(presentation.focusedID == "current")
        #expect(presentation.rowTitle(Self.entry("current")) == "current — Needs attention")
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
}
