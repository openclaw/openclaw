import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardAppLinkRecorder: NSObject, WKScriptMessageHandler {
    var urls: [String] = []

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        #expect(message.world === DashboardAppLinkMessageHandler.world)
        #expect(message.frameInfo.isMainFrame)
        if let url = message.body as? String { self.urls.append(url) }
    }
}

@Suite(.serialized)
@MainActor
struct DashboardAppLinkBridgeTests {
    @Test(arguments: ["_self", "_blank"])
    func `native app-link activation is isolated from page scripts`(_ target: String) async throws {
        let server = try await DashboardHTTPFixture.start(
            html: "<html><body><a id='launch' href='openclaw://dashboard' target='\(target)'>Open</a></body></html>")
        defer { server.stop() }
        let auth = DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        let controller = DashboardWindowController(
            url: server.url(), auth: auth, websiteDataStore: .nonPersistent(),
            windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        // Observe the production listener at its native sink without launching
        // app-wide navigation. The page handler and user-script setup stay real.
        let messages = controller.webView.configuration.userContentController
        let recorder = DashboardAppLinkRecorder()
        messages.removeScriptMessageHandler(
            forName: DashboardAppLinkMessageHandler.name,
            contentWorld: DashboardAppLinkMessageHandler.world)
        messages.add(
            recorder,
            contentWorld: DashboardAppLinkMessageHandler.world,
            name: DashboardAppLinkMessageHandler.name)
        controller.show(url: server.url(), auth: auth)
        try await self.waitUntil {
            !controller.webView.isLoading && controller.canDeliverNativeCommands
        }
        let pageHasHandler = try await controller.webView.callAsyncJavaScript(
            "return typeof window.webkit.messageHandlers.openclawAppLink !== 'undefined';",
            in: nil, contentWorld: .page) as? Bool
        #expect(pageHasHandler == false)
        let isolatedHasHandler = try await controller.webView.callAsyncJavaScript(
            "return typeof window.webkit.messageHandlers.openclawAppLink !== 'undefined';",
            in: nil, contentWorld: DashboardAppLinkMessageHandler.world) as? Bool
        #expect(isolatedHasHandler == true)

        try await controller.webView.evaluateJavaScript("document.getElementById('launch').click()")
        #expect(recorder.urls.isEmpty)
        try await controller.webView.evaluateJavaScript("document.getElementById('launch').focus()")
        let window = try #require(controller.window)
        window.makeFirstResponder(controller.webView)
        let enter = try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: 36))
        controller.webView.keyDown(with: enter)
        try await self.waitUntil { !recorder.urls.isEmpty }
        #expect(recorder.urls == ["openclaw://dashboard"])
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
