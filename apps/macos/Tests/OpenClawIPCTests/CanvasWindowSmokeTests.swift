import AppKit
import Foundation
import OpenClawIPC
import PDFKit
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

    @Test func `panel shows text documents and a visible error when a load fails`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-canvas-test-\(UUID().uuidString)")
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: root) }
        let sessionKey = "canvas-load-test-\(UUID().uuidString)"
        defer { AppDefaults.standard.removeObject(
            forKey: CanvasWindowController.storedFrameDefaultsKey(sessionKey: sessionKey)) }
        let controller = try CanvasWindowController(
            sessionKey: sessionKey,
            root: root,
            anchorProvider: { NSRect(x: 200, y: 400, width: 40, height: 40) },
            websiteDataStore: .nonPersistent())
        defer { controller.close() }
        let dir = URL(fileURLWithPath: controller.directoryPath)
        try "# Canvas note marker".write(to: dir.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)
        try Data([0, 1, 2]).write(to: dir.appendingPathComponent("blob.bin"))
        let pdf = PDFDocument()
        pdf.insert(PDFPage(), at: 0)
        try #require(pdf.dataRepresentation()).write(to: dir.appendingPathComponent("doc.pdf"))
        controller.showCanvas()

        controller.load(target: "/note.md")
        #expect(await Self.pageText(of: controller, contains: "Canvas note marker"))

        controller.load(target: "/doc.pdf")
        #expect(await Self.loaded(controller, pathSuffix: "/doc.pdf"))
        #expect(!(await Self.pageText(of: controller, contains: "Canvas couldn't show this page")))

        // WebKit refuses to display application/octet-stream in a frame; the panel must say so.
        controller.load(target: "/blob.bin")
        #expect(await Self.pageText(of: controller, contains: "Canvas couldn't show this page"))
    }

    private static func loaded(_ controller: CanvasWindowController, pathSuffix: String) async -> Bool {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(100))
            if !controller.webView.isLoading, controller.webView.url?.path.hasSuffix(pathSuffix) == true { return true }
        }
        return false
    }

    private static func pageText(of controller: CanvasWindowController, contains needle: String) async -> Bool {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(100))
            if !controller.webView.isLoading,
               let text = try? await controller.webView.evaluateJavaScript("document.body ? document.body.innerText : ''")
               as? String,
               text.contains(needle)
            {
                return true
            }
        }
        return false
    }
}
