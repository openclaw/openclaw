import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct StatusMenuRecoveryPresentationTests {
    @Test func `worker recovery row renders guidance and only offers a callable update`() async throws {
        _ = AppKitTestSupport.application
        let diagnostic = "OpenClaw state database uses newer schema version 18; this build supports 17."
        let mismatch = MacNodeChannelState.connected(
            workerUnavailableReason: "worker exited with status exited(1)",
            diagnostic: diagnostic)
        let beforeLine: (
            label: String,
            diagnostic: String?,
            isDegraded: Bool,
            recoveryAction: MacNodeChannelState.RecoveryAction?) = (
                "Mac node degraded — worker exited with status exited(1)", diagnostic, true, nil)
        let afterLine = try #require(mismatch.operatorStatusLine)
        var updateCalls = 0

        try await self.capture(beforeLine, name: "worker-schema-before", onCheckForUpdates: nil) { buttons in
            #expect(!buttons.contains("Update"))
        }
        try await self.capture(afterLine, name: "worker-schema-after", onCheckForUpdates: {
            updateCalls += 1
        }) { buttons in
            #expect(buttons.contains("Update"))
        }
        try await self.capture(afterLine, name: "worker-schema-no-updater", onCheckForUpdates: nil) { buttons in
            #expect(!buttons.contains("Update"))
        }
        #expect(updateCalls == 1)
    }

    private func capture(
        _ line: (label: String, diagnostic: String?, isDegraded: Bool, recoveryAction: MacNodeChannelState.RecoveryAction?),
        name: String,
        onCheckForUpdates: (@MainActor () -> Void)?,
        verify: ([String]) throws -> Void) async throws
    {
        let view = StatusMenuProblemLineView(
            label: line.label,
            diagnostic: line.diagnostic,
            color: line.isDegraded ? .orange : .red,
            onCheckForUpdates: onCheckForUpdates)
            .padding(14)
            .frame(width: StatusMenuMetrics.width, alignment: .leading)
            .background(.regularMaterial)
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(x: 0, y: 0, width: StatusMenuMetrics.width, height: 130)
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
        let elements = try await AppKitTestSupport.accessibilityElements(in: hosting)
        let controls = elements.filter {
            $0.accessibilityRole?() == .button || $0.accessibilityRole?() == .link
        }
        let directory = try #require(ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"])
        let image = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: image)
        let png = try #require(image.representation(using: .png, properties: [:]))
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try png.write(to: output.appendingPathComponent("\(name)-window.png"))
        let status: [String: Any] = [
            "name": name,
            "source": "StatusMenuProblemLineView",
            "synthetic": true,
            "baselinePresentationReconstructed": name == "worker-schema-before",
            "updateActionAvailable": onCheckForUpdates != nil,
            "accessibilityElements": elements.map {
                [
                    "role": String(describing: $0.accessibilityRole?()),
                    "name": AppKitTestSupport.accessibilityName(of: $0) ?? "",
                ]
            },
            "requiresVisualInspection": true,
        ]
        try JSONSerialization.data(withJSONObject: status, options: [.sortedKeys])
            .write(to: output.appendingPathComponent("\(name)-capture-status.json"))

        try verify(controls.compactMap(AppKitTestSupport.accessibilityName(of:)))
        if onCheckForUpdates != nil {
            let button = try #require(controls.first {
                AppKitTestSupport.accessibilityName(of: $0) == "Update"
            })
            #expect(button.accessibilityPerformPress?() == true)
        }
    }
}
