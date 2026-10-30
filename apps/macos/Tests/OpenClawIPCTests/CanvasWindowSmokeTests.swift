import AppKit
import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CanvasWindowSmokeTests {
    @Test func `panel controller shows and hides`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-canvas-test-\(UUID().uuidString)")
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: root) }

        let anchor = { NSRect(x: 200, y: 400, width: 40, height: 40) }
        let controller = try CanvasWindowController(
            sessionKey: "  main/invalid⚡️  ",
            root: root,
            anchorProvider: anchor)

        #expect(controller.directoryPath.contains("main_invalid__") == true)
        #expect(controller.webView.configuration.preferences.tabFocusesLinks)
        #expect(controller.watcher.isPolling == false)

        controller.preferredPlacement = CanvasPlacement(x: 120, y: 200, width: 520, height: 680)
        controller.load(target: "/")
        #expect(controller.watcher.isPolling == false)
        let localURL = try #require(CanvasScheme.makeURL(session: "main", path: "/"))
        controller.updateFilePollingForCommittedNavigation(to: localURL)
        controller.showCanvas()
        #expect(controller.watcher.isPolling)
        let remoteURL = try #require(URL(string: "https://example.com"))
        controller.load(target: remoteURL.absoluteString)
        #expect(controller.watcher.isPolling)
        controller.updateFilePollingForCommittedNavigation(to: remoteURL)
        #expect(controller.watcher.isPolling == false)
        controller.load(target: "/")
        #expect(controller.watcher.isPolling == false)
        controller.updateFilePollingForCommittedNavigation(to: localURL)
        #expect(controller.watcher.isPolling)
        controller.windowDidMove(Notification(name: NSWindow.didMoveNotification))
        controller.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification))
        controller.hideCanvas()
        #expect(controller.watcher.isPolling == false)
        controller.close()
    }

    @Test func `repeated present applies and remembers its own placement`() throws {
        // Without a screen (headless runner) the panel keeps the requested frame unconstrained.
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        try #require(visible.width >= 700 && visible.height >= 600)

        let sessionKey = "canvas-placement-\(UUID().uuidString)"
        let manager = CanvasManager.shared
        let previousAnchor = manager.defaultAnchorProvider
        manager.defaultAnchorProvider = { NSRect(x: visible.midX, y: visible.midY, width: 1, height: 1) }
        var sessionDirectory: String?
        defer {
            manager.hide(sessionKey: sessionKey)
            manager.defaultAnchorProvider = previousAnchor
            AppDefaults.standard.removeObject(
                forKey: CanvasWindowController.storedFrameDefaultsKey(sessionKey: sessionKey))
            if let sessionDirectory { try? FileManager().removeItem(atPath: sessionDirectory) }
        }

        func present(_ frame: NSRect?) throws -> (shown: NSRect?, remembered: NSRect?) {
            sessionDirectory = try manager.show(sessionKey: sessionKey, placement: frame.map {
                CanvasPlacement(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height)
            })
            let panel = NSApplication.shared.windows.first {
                ($0.delegate as? CanvasWindowController)?.sessionKey == sessionKey
            }
            return (panel?.frame, CanvasWindowController.loadRestoredFrame(sessionKey: sessionKey))
        }

        let first = NSRect(x: visible.minX + 40, y: visible.minY + 40, width: 400, height: 400)
        let second = NSRect(x: visible.minX + 120, y: visible.minY + 80, width: 520, height: 480)

        let created = try present(first)
        #expect(created.shown == first)
        #expect(created.remembered == first)

        // The panel already exists: this present must move it now, not on the next present.
        let reused = try present(second)
        #expect(reused.shown == second)
        #expect(reused.remembered == second)

        // A present without placement keeps the remembered frame.
        let plain = try present(nil)
        #expect(plain.shown == second)
        #expect(plain.remembered == second)
    }

    @Test func `hosted Canvas URL resolver keeps capability scope`() throws {
        let surface = "https://gateway.example/root/__openclaw__/cap/token%20value"
        let canvas = try #require(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/demo%20page.html?mode=proof#result"))
        #expect(canvas.absoluteString ==
            "https://gateway.example/root/__openclaw__/cap/token%20value/__openclaw__/canvas/demo%20page.html?mode=proof#result")

        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "/local.html") == nil)
        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "https://example.com/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/../other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/%252e%252e/other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/%25252525252e%25252525252e/other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: "https://gateway.example/not-capability-scoped",
            target: "/__openclaw__/canvas/") == nil)
    }

    @Test func `Canvas target resolver accepts only hosted paths and app-local URLs`() {
        #expect(CanvasHostedURLResolver.isHostedTarget(
            "/__openclaw__/canvas/documents/widget/index.html"))
        #expect(CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas://main/widget/index.html"))

        #expect(!CanvasHostedURLResolver.isAppLocalTarget("https://example.com/widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("file:///tmp/widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas:///widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas://main/%252e%252e/secret"))
    }
}
