import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardCloseShortcutTests {
    @Test func `command W routes native browser focus to the visible presenting panel`() async throws {
        let previousMenu = self.installCloseMenu()
        defer { NSApp.mainMenu = previousMenu }
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = self.makeController(server: server)
        defer { controller.closeDashboard() }
        try await self.waitForDocument(controller)
        let window = try #require(controller.window)
        try await controller.webView.evaluateJavaScript("""
        window.closeScope = null;
        window.addEventListener('openclaw:native-close-focused-panel', event => {
          window.closeScope = event.detail?.browserScope;
          event.preventDefault();
        });
        """)
        try controller.nativeBrowser.open(tabId: "focused", url: #require(URL(string: "about:blank")))
        let browser = try #require(controller.nativeBrowser.webView(for: "focused"))
        let rect = DashboardBrowserRect(x: 100, y: 100, width: 300, height: 200)
        try controller.nativeBrowser.present(scope: "older-panel", tabId: "focused", rect: rect, visible: true)
        try controller.nativeBrowser.present(scope: "visible-panel", tabId: "focused", rect: rect, visible: true)
        #expect(window.makeFirstResponder(browser))

        try self.pressCommandW(in: window)
        try await self.waitUntil {
            try await controller.webView.evaluateJavaScript("window.closeScope") as? String == "visible-panel"
        }
        #expect(window.isVisible)
        controller.nativeBrowser.releaseScope("visible-panel")
        try self.pressCommandW(in: window)
        try await self.waitUntil {
            try await controller.webView.evaluateJavaScript("window.closeScope") as? String == "older-panel"
        }
        #expect(window.isVisible)
    }

    @Test(arguments: ["w", "ц", ","])
    func `command W lets the focused panel close before the native window`(_ baseCharacter: String) async throws {
        let previousMenu = self.installCloseMenu()
        defer { NSApp.mainMenu = previousMenu }
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = self.makeController(server: server)
        defer { controller.closeDashboard() }
        try await self.waitForDocument(controller)
        let window = try #require(controller.window)
        try await controller.webView.evaluateJavaScript("""
        window.panelOpen = true;
        window.addEventListener('openclaw:native-close-focused-panel', event => {
          if (!window.panelOpen) return;
          window.panelOpen = false;
          event.preventDefault();
        });
        """)

        try self.pressCommandW(in: window, baseCharacter: baseCharacter)
        try await self.waitUntil {
            if !window.isVisible {
                return true
            }
            return try await controller.webView.evaluateJavaScript("window.panelOpen") as? Bool == false
        }
        #expect(window.isVisible)
        #expect(try await controller.webView.evaluateJavaScript("window.panelOpen") as? Bool == false)

        // With no panel claiming the next command, ordinary window closing remains available.
        try self.pressCommandW(in: window, baseCharacter: baseCharacter)
        try await self.waitUntil { !window.isVisible }
    }

    @Test func `traffic light closes the window without asking the focused panel`() async throws {
        let previousMenu = self.installCloseMenu()
        defer { NSApp.mainMenu = previousMenu }
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = self.makeController(server: server)
        defer { controller.closeDashboard() }
        try await self.waitForDocument(controller)
        try await controller.webView.evaluateJavaScript("""
        window.addEventListener('openclaw:native-close-focused-panel', event => event.preventDefault());
        """)
        let window = try #require(controller.window)
        try #require(window.isVisible)
        try #require(window.standardWindowButton(.closeButton)).performClick(nil)
        #expect(!window.isVisible)
    }

    @Test func `command W on an unavailable dashboard still closes the window`() async throws {
        let previousMenu = self.installCloseMenu()
        defer { NSApp.mainMenu = previousMenu }
        let controller = try DashboardWindowController(
            url: #require(URL(string: "about:blank")),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.showFailure(title: "Unavailable", message: "Offline")
        let window = try #require(controller.window)
        try #require(window.isVisible)
        try self.pressCommandW(in: window)
        try await self.waitUntil { !window.isVisible }
        #expect(!window.isVisible)
    }

    private func installCloseMenu() -> NSMenu? {
        _ = AppKitTestSupport.application
        let previous = NSApp.mainMenu
        let menu = NSMenu()
        let file = menu.addItem(withTitle: "File", action: nil, keyEquivalent: "")
        file.submenu = NSMenu(title: "File")
        file.submenu?.addItem(
            withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = menu
        return previous
    }

    private func makeController(server: DashboardHTTPFixture) -> DashboardWindowController {
        _ = AppKitTestSupport.application
        let controller = DashboardWindowController(
            url: server.url(),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        controller.loadInBackground(
            url: server.url(), auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        controller.show()
        return controller
    }

    private func pressCommandW(in window: NSWindow, baseCharacter: String = "w") throws {
        // The accessory test runner has no app event loop to establish a key window.
        // Give its Close menu the same target AppKit resolves in the running app.
        let close = try #require(NSApp.mainMenu?.item(withTitle: "File")?.submenu?.item(withTitle: "Close Window"))
        close.target = window
        let event = try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "w",
            charactersIgnoringModifiers: baseCharacter,
            isARepeat: false,
            keyCode: 13))
        // Command-remapped layouts translate characters but retain their base glyph
        // in charactersIgnoringModifiers. AppKit tries the window before the menu.
        if !window.performKeyEquivalent(with: event) {
            #expect(NSApp.sendAction(#selector(NSWindow.performClose(_:)), to: window, from: nil))
        }
    }

    private func waitForDocument(_ controller: DashboardWindowController) async throws {
        try await self.waitUntil {
            controller.webView.url != nil && !controller.webView.isLoading && controller.canDeliverNativeCommands
        }
    }

    private func waitUntil(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while try await !condition() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
