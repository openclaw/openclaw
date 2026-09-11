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
                [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains(title)
            })
            #expect(recovery.accessibilityPerformPress?() == true)
            #expect(installs == 1)
            #expect(rechecks == 0)
            let recheck = try #require(buttons.first {
                [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains("Recheck")
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
                [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains("Recheck")
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
        _ body: ([AnyObject]) throws -> Void) async throws
    {
        _ = AppKitTestSupport.application
        let hosting = NSHostingView(rootView: Form { view }.formStyle(.grouped))
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
        try body(buttons)
    }
}
