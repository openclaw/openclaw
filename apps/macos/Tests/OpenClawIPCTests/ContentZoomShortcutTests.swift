import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct ContentZoomShortcutTests {
    @Test func dashboardShortcutsPreserveDraftChromeAndOtherWindows() async throws {
        try await TestIsolation.withUserDefaultsValues(["openclaw.contentZoom": nil]) {
            _ = AppKitTestSupport.application
            let server = try await DashboardHTTPFixture.start(
                html: Self.html, contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'")
            defer { server.stop() }
            let controller = self.makeController(server)
            let other = self.makeController(server)
            defer {
                controller.closeDashboard()
                other.closeDashboard()
            }
            try await DashboardTestWait.document(controller, "zoom document")
            try await DashboardTestWait.document(other, "other zoom document")
            let window = try #require(controller.window)
            try #require(window.makeFirstResponder(controller.webView))
            _ = try await controller.webView.evaluateJavaScript("document.getElementById('composer').focus()")
            try await self.capture(controller.webView, name: "content-zoom-before")

            try self.press("=", in: window)
            #expect(abs(controller.webView.pageZoom - 1.1) < 0.001)
            try self.press("+", modifiers: [.command, .shift], in: window)
            try self.press("=", in: window)
            #expect(abs(controller.webView.pageZoom - 1.3) < 0.001)
            #expect(other.webView.pageZoom == 1)
            #expect(try await controller.webView.evaluateJavaScript(
                "document.getElementById('composer').value") as? String == "Keep this draft")
            #expect(try await controller.webView.evaluateJavaScript("document.activeElement.id") as? String == "composer")
            try await self.expectChrome(controller.webView)
            try await self.capture(controller.webView, name: "content-zoom-after")

            // A new window restores the profile preference; the existing peer
            // retains its own reading size until the user changes it.
            let restored = self.makeController(server)
            defer { restored.closeDashboard() }
            #expect(abs(restored.webView.pageZoom - 1.3) < 0.001)
            controller.webView.reload()
            try await DashboardTestWait.document(controller, "reloaded zoom document")
            try await self.expectChrome(controller.webView)
            try self.press("-", in: window)
            #expect(abs(controller.webView.pageZoom - 1.2) < 0.001)
            try self.press("0", in: window)
            #expect(controller.webView.pageZoom == 1)

            for _ in 0..<20 { try self.press("-", in: window) }
            #expect(controller.webView.pageZoom == 0.5)
            try await self.expectChrome(controller.webView)
            for _ in 0..<20 { try self.press("=", in: window) }
            #expect(controller.webView.pageZoom == 2)
            try await self.expectChrome(controller.webView)
            try self.press("0", in: window)
            #expect(AppDefaults.standard.double(forKey: "openclaw.contentZoom") == 1)
        }
    }

    @Test func sharedWindowZoomsTranscriptFromNativeFocusButNotHiddenContent() async throws {
        try await TestIsolation.withUserDefaultsValues(["openclaw.contentZoom": 1]) {
            _ = AppKitTestSupport.application
            let server = try await DashboardHTTPFixture.start(
                html: Self.html, contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'")
            defer { server.stop() }
            let document = ControlUIDocumentHost(
                url: server.url(), auth: .unauthenticated, websiteDataStore: .nonPersistent(),
                installCapabilities: { _ in })
            let window = ExperienceWindow(
                contentRect: NSRect(x: 0, y: 0, width: 960, height: 700),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            defer {
                document.webView.stopLoading()
                window.close()
            }
            let sidebar = NSTextField(string: "Native sidebar")
            sidebar.frame = NSRect(x: 20, y: 640, width: 200, height: 30)
            let container = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 700))
            container.addSubview(sidebar)
            document.webView.frame = NSRect(x: 240, y: 0, width: 720, height: 700)
            container.addSubview(document.webView)
            window.contentView = container
            window.orderFront(nil)
            document.load(server.url())
            try await TestWait.state("native transcript document") {
                guard !document.webView.isLoading else { return false }
                return try await document.webView.evaluateJavaScript("document.getElementById('composer') != null") as? Bool == true
            }
            try #require(window.makeFirstResponder(sidebar))
            let nativeResponder = window.firstResponder
            try self.press("=", in: window)
            #expect(abs(document.webView.pageZoom - 1.1) < 0.001)
            #expect(window.firstResponder === nativeResponder)
            document.webView.isHidden = true
            _ = try self.send("=", in: window)
            #expect(abs(document.webView.pageZoom - 1.1) < 0.001)
        }
    }

    @Test(arguments: ["legacy", "existing", "early-shortcut"])
    func legacyScaleUsesTheNativeOwnerWithoutOverwritingZoom(_ scenario: String) async throws {
        let saved: Double? = scenario == "existing" ? 1.4 : nil
        try await TestIsolation.withUserDefaultsValues([
            "openclaw.contentZoom": saved,
            "content-zoom-unrelated": "keep",
        ]) {
            _ = AppKitTestSupport.application
            let server = try await DashboardHTTPFixture.start(
                html: Self.html, contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'")
            defer { server.stop() }
            let controller = self.makeController(server)
            defer { controller.closeDashboard() }
            try await DashboardTestWait.document(controller, "legacy zoom preference document")
            let window = try #require(controller.window)
            if scenario == "early-shortcut" { try self.press("=", in: window) }
            _ = try await controller.webView.callAsyncJavaScript(
                "await window.__OPENCLAW_NATIVE_CONTENT_ZOOM__.adoptLegacyTextScale(125); return true;",
                in: nil, contentWorld: .page)
            // The real window callback settles a deferred background document.
            // Like performKeyEquivalent above, this does not claim physical OS input.
            window.becomeKey()
            let expected = scenario == "existing" ? 1.4 : scenario == "early-shortcut" ? 1.1 : 1.25
            #expect(abs(controller.webView.pageZoom - expected) < 0.001)
            #expect(abs(AppDefaults.standard.double(forKey: "openclaw.contentZoom") - expected) < 0.001)
            #expect(AppDefaults.standard.string(forKey: "content-zoom-unrelated") == "keep")
            if scenario == "legacy" {
                try self.press("=", in: window)
                #expect(abs(controller.webView.pageZoom - 1.35) < 0.001)
            }
            try self.press("0", in: window)
            if scenario == "legacy" {
                controller.webView.reload()
                try await DashboardTestWait.document(controller, "reset legacy zoom document")
            }
            _ = try await controller.webView.callAsyncJavaScript(
                "await window.__OPENCLAW_NATIVE_CONTENT_ZOOM__.adoptLegacyTextScale(140); return true;",
                in: nil, contentWorld: .page)
            window.becomeKey()
            #expect(controller.webView.pageZoom == 1)
            #expect(AppDefaults.standard.double(forKey: "openclaw.contentZoom") == 1)
        }
    }

    private func makeController(_ server: DashboardHTTPFixture) -> DashboardWindowController {
        let controller = DashboardWindowController(
            url: server.url(), auth: .unauthenticated, websiteDataStore: .nonPersistent(),
            windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
        controller.show(url: server.url(), auth: .unauthenticated)
        return controller
    }

    private func press(_ key: String, modifiers: NSEvent.ModifierFlags = .command, in window: NSWindow) throws {
        #expect(try self.send(key, modifiers: modifiers, in: window))
    }

    private func send(
        _ key: String, modifiers: NSEvent.ModifierFlags = .command, in window: NSWindow) throws -> Bool
    {
        let event = try #require(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: key, charactersIgnoringModifiers: key,
            isARepeat: false, keyCode: key == "-" ? 27 : key == "0" ? 29 : 24))
        // Exercise AppKit's window entry point, not synthetic JavaScript keys.
        // This does not claim physical keyboard or NSApplication menu delivery.
        return window.performKeyEquivalent(with: event)
    }

    private func expectChrome(_ webView: WKWebView) async throws {
        try await TestWait.state("zoomed titlebar clearance") {
            let height = try await webView.evaluateJavaScript(
                "document.getElementById('titlebar').getBoundingClientRect().height") as? Double
            let inset = try await webView.evaluateJavaScript(
                "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--openclaw-native-controls-inset'))") as? Double
            let chromeScale = try await webView.evaluateJavaScript(
                "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--openclaw-native-chrome-scale'))") as? Double
            return height.map { abs($0 * webView.pageZoom - 52) < 0.1 } == true &&
                inset.map { abs($0 * webView.pageZoom - 92) < 0.1 } == true &&
                chromeScale.map { abs($0 * webView.pageZoom - 1) < 0.001 } == true
        }
    }

    private func capture(_ webView: WKWebView, name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let image = try await webView.takeSnapshot(configuration: configuration)
        let tiff = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiff))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-window.png"))
    }

    private static let html = """
    <!doctype html><html><head><style>
    html,body{margin:0;background:#f6f7f9;color:#20242c;font:16px -apple-system}
    #titlebar{height:var(--openclaw-native-titlebar-height);background:#e7ebf1}
    main{margin:40px;max-width:650px}h1{font-size:28px}p{line-height:1.6}
    textarea{font:inherit;width:100%;height:70px;padding:12px;box-sizing:border-box}
    </style></head><body><div id="titlebar"></div><main>
    <h1>Readable conversations</h1><p>Synthetic native WebKit shortcut fixture.</p>
    <p>Command-plus makes the conversation easier to read. The native titlebar
    keeps its clearance while content grows. Command-zero restores actual size.</p>
    <textarea id="composer">Keep this draft</textarea></main></body></html>
    """
}
