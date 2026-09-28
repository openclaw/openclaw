import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardAppLinkRecorder: NSObject, WKScriptMessageHandler {
    var urls: [String] = []
    private var waiter: CheckedContinuation<Void, Never>?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        #expect(message.world === DashboardAppLinkMessageHandler.world)
        #expect(message.frameInfo.isMainFrame)
        if let url = message.body as? String { self.urls.append(url) }
        self.waiter?.resume()
        self.waiter = nil
    }

    func waitForMessage() async {
        guard self.urls.isEmpty else { return }
        await withCheckedContinuation { self.waiter = $0 }
    }
}

/// Resumes after WebKit finishes the dashboard load. WebKit publishes `isLoading`
/// and calls the controller's `didFinish` in the same main-thread turn, so the
/// controller has settled before the waiting task resumes. No wall-clock deadline:
/// shared main-actor load in the native suite cannot fail this wait.
@MainActor
private final class DashboardLoadCompletion {
    private var sawLoading = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var observation: NSKeyValueObservation?

    func wait(for webView: WKWebView, _ start: () -> Void) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.observation = webView.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.update(isLoading: webView.isLoading) }
            }
            start()
        }
        self.observation = nil
    }

    private func update(isLoading: Bool) {
        guard !isLoading else {
            self.sawLoading = true
            return
        }
        guard self.sawLoading else { return }
        self.continuation?.resume()
        self.continuation = nil
    }
}

@Suite(.serialized)
@MainActor
struct DashboardAppLinkBridgeTests {
    // Event waits have no deadline of their own; the limit only bounds a lost event.
    @Test(.timeLimit(.minutes(2)), arguments: ["_self", "_blank"])
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
        await DashboardLoadCompletion().wait(for: controller.webView) {
            controller.show(url: server.url(), auth: auth)
        }
        #expect(controller.canDeliverNativeCommands)
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
        await recorder.waitForMessage()
        #expect(recorder.urls == ["openclaw://dashboard"])
    }
}
