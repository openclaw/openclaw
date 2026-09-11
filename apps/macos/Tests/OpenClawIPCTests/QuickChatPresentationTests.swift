import AppKit
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import XCTest
@testable import OpenClaw

@MainActor
final class QuickChatPresentationTests: XCTestCase {
    func testShortcutPresentsAnEditorWithoutRequiringForegroundOwnership() async throws {
        let application = AppKitTestSupport.application
        var shortcut: (() -> Void)?
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main", mainkey: "main", scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Fixture")])
            },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture })
        let controller = QuickChatController(
            enableUI: true,
            model: model,
            monitoringEnabled: false,
            hotkeyRegistrar: { shortcut = $0 },
            hotkeyRemover: { shortcut = nil },
            allowsHotkeyRegistrationInTests: true)
        defer { controller.stop() }
        controller.start()
        controller.setEnabled(true)
        application.deactivate()
        try await self.waitUntil { !application.isActive }
        try XCTUnwrap(shortcut)()

        try await self.waitUntil { controller.isVisible && !model.isLoadingModelControls }
        let panel = try XCTUnwrap(application.windows.first {
            ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
        })
        XCTAssertTrue(panel.isVisible)
        XCTAssertFalse(panel.hidesOnDeactivate)
        try await self.waitUntil { panel.firstResponder is NSTextView }
        XCTAssertTrue(panel.firstResponder is NSTextView)
        print(
            "Quick Chat presented: visible=\(panel.isVisible), active=\(application.isActive), key=\(panel.isKeyWindow), editorReady=\(panel.firstResponder is NSTextView)")

        let content = try XCTUnwrap(panel.contentView)
        content.layoutSubtreeIfNeeded()
        let image = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: image)
        let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("quick-chat-proof", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try XCTUnwrap(image.representation(using: .png, properties: [:]))
            .write(to: output.appendingPathComponent("presented.png"))

        controller.dismiss()
        try XCTUnwrap(shortcut)()
        try await self.waitUntil { controller.isVisible }
        XCTAssertTrue(panel.isVisible)
        print("Quick Chat reopened: visible=\(panel.isVisible)")
        controller.setEnabled(false)
        XCTAssertFalse(controller.isVisible)
        XCTAssertNil(shortcut)
        print("Quick Chat disabled: visible=\(controller.isVisible), shortcutRegistered=\(shortcut != nil)")
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}
