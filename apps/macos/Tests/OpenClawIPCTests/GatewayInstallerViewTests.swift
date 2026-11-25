import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayInstallerViewTests {
    @Test(arguments: [
        (GatewayEnvironmentKind.missingGateway, "Install Gateway…"),
        (.missingNode, "Install Gateway…"),
        (.incompatible(found: "2026.7.1-2", required: "2026.9.3"), "Update Gateway…"),
        (.incompatible(found: "2026.9.4-beta.1", required: "2026.9.3"), "Set Up Gateway…"),
        (.error("CLI could not be verified"), "Repair Gateway…"),
    ])
    func `offline errors offer an actionable recovery`(kind: GatewayEnvironmentKind, title: String) async throws {
        var installs = 0
        var rechecks = 0
        let view = self.view(kind: kind, onInstall: { installs += 1 }, onRecheck: { rechecks += 1 })
        try await self.withButtons(view) { buttons in
            // SwiftUI virtual AX buttons can expose their name through label instead of title.
            let recovery = try #require(buttons.first {
                [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].contains(title)
            })
            #expect(recovery.accessibilityPerformPress?() == true)
            #expect(installs == 1)
            #expect(rechecks == 0)
            let recheck = try #require(buttons.first {
                [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].contains("Recheck")
            })
            #expect(recheck.accessibilityPerformPress?() == true)
            #expect(rechecks == 1)
        }
    }

    @Test(arguments: [GatewayEnvironmentKind.ok, .checking])
    func `ready or checking gateways do not offer replacement`(kind: GatewayEnvironmentKind) async throws {
        try await self.withButtons(self.view(kind: kind)) { buttons in
            #expect(buttons.count == 1)
            #expect(buttons.contains {
                [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].contains("Recheck")
            })
        }
    }

    @Test func `installation disables both recovery and recheck`() async throws {
        let view = self.view(kind: .missingGateway, isInstalling: true)
        try await self.withButtons(view) { buttons in
            #expect(buttons.count == 2)
            #expect(buttons.allSatisfy { $0.isAccessibilityEnabled?() == false })
        }
    }

    @Test func `manual recovery remains available after an earlier prompt was dismissed`() {
        #expect(!CLIInstallPrompter.shouldPrompt(
            version: "2026.9.3", lastPrompt: "2026.9.3", userInitiated: false))
        #expect(CLIInstallPrompter.shouldPrompt(
            version: "2026.9.3", lastPrompt: "2026.9.3", userInitiated: true))
        #expect(CLIInstallPrompter.shouldPrompt(
            version: "2026.9.3", lastPrompt: "2026.7.1", userInitiated: false))
        #expect(CLIInstallPrompter.shouldPrompt(
            version: "2026.9.3", lastPrompt: nil, userInitiated: false))
    }

    @Test func `bundled status exposes callable recovery without offering a healthy Gateway downgrade`() async throws {
        // Reconstruct the pre-fix bundled branch: it advertised the app version without checking the service.
        let before = GatewayEnvironmentStatus(
            kind: .ok,
            nodeVersion: nil,
            gatewayVersion: "2026.10.6",
            requiredGateway: "2026.10.6",
            message: "Bundled Bun runtime; Gateway 2026.10.6")
        let older = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .incompatible(location: "/fixture/service", found: "2026.10.2", required: "2026.10.6"),
            expected: "2026.10.6",
            connectedVersion: "2026.10.2",
            seedMatchesBundle: true,
            recoveryPending: true)
        let pendingNewer = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .ready(location: "/fixture/service", version: "2026.10.7"),
            expected: "2026.10.6",
            connectedVersion: "2026.10.7",
            seedMatchesBundle: false,
            recoveryPending: true)
        let healthyNewer = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .ready(location: "/fixture/service", version: "2026.10.7"),
            expected: "2026.10.6",
            connectedVersion: "2026.10.7",
            seedMatchesBundle: false,
            recoveryPending: false)

        let scenarios: [(GatewayEnvironmentStatus, String?, String)] = [
            (before, nil, "gateway-status-before"),
            (older, "Update Gateway…", "gateway-status-after"),
            (pendingNewer, "Repair Gateway…", "gateway-status-pending-newer"),
            (healthyNewer, nil, "gateway-status-healthy-newer"),
        ]
        for (status, title, captureName) in scenarios {
            var installs = 0
            let view = GatewayInstallerView(
                status: status,
                failure: nil,
                existingGatewayDetails: nil,
                isInstalling: false,
                installStatus: nil,
                onInstall: { installs += 1 },
                onRecheck: {})
            try await self.withButtons(view, captureName: captureName) { buttons in
                let names = buttons.compactMap(AppKitTestSupport.accessibilityName(of:))
                if let title {
                    #expect(Set(names) == Set([title, "Recheck"]))
                    let recovery = try #require(buttons.first {
                        AppKitTestSupport.accessibilityName(of: $0) == title
                    })
                    #expect(recovery.accessibilityPerformPress?() == true)
                    #expect(installs == 1)
                } else {
                    #expect(names == ["Recheck"])
                    #expect(installs == 0)
                }
            }
        }
    }

    private func view(
        kind: GatewayEnvironmentKind,
        isInstalling: Bool = false,
        onInstall: @escaping () -> Void = {},
        onRecheck: @escaping () -> Void = {}) -> GatewayInstallerView
    {
        GatewayInstallerView(
            status: .init(
                kind: kind,
                nodeVersion: "26.8.1",
                gatewayVersion: "2026.7.1-2",
                requiredGateway: "2026.9.3",
                message: "Gateway setup fixture"),
            failure: nil,
            existingGatewayDetails: nil,
            isInstalling: isInstalling,
            installStatus: isInstalling ? "Installing OpenClaw CLI…" : nil,
            onInstall: onInstall,
            onRecheck: onRecheck)
    }

    private func withButtons(
        _ view: GatewayInstallerView,
        captureName: String? = nil,
        _ body: ([AnyObject]) throws -> Void) async throws
    {
        _ = AppKitTestSupport.application
        let hosting = NSHostingView(rootView: Form { view }.formStyle(.grouped)
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.colorScheme, .light))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(x: 0, y: 0, width: 1100, height: 400)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
        window.orderFront(nil)
        hosting.layoutSubtreeIfNeeded()
        let buttons = try await AppKitTestSupport.accessibilityElements(in: hosting).filter {
            $0.accessibilityRole?() == .button
        }
        if let captureName,
           let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"]
        {
            let image = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: image)
            let png = try #require(image.representation(using: .png, properties: [:]))
            let output = URL(fileURLWithPath: directory, isDirectory: true)
            try png.write(to: output.appendingPathComponent("\(captureName)-window.png"))
            let metadata: [String: Any] = [
                "name": captureName,
                "source": "GatewayInstallerView",
                "synthetic": true,
                "baselinePresentationReconstructed": captureName == "gateway-status-before",
                "gatewayVersion": view.status.gatewayVersion ?? "unknown",
                "buttons": buttons.compactMap(AppKitTestSupport.accessibilityName(of:)),
                "requiresVisualInspection": true,
            ]
            try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
                .write(to: output.appendingPathComponent("\(captureName)-capture-status.json"))
        }
        try body(buttons)
    }
}
