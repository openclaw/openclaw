import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

/// One-shot wake-up for a main-actor test event. Cancellation resumes a pending
/// wait, so the test's time limit still ends a wait whose event never arrives.
@MainActor
private final class DashboardEventSignal {
    private var fired = false
    private var continuation: CheckedContinuation<Void, Error>?

    func fire() {
        self.fired = true
        self.continuation?.resume()
        self.continuation = nil
    }

    func wait() async throws {
        guard !self.fired else { return }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { self.continuation = $0 }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    private func cancel() {
        self.continuation?.resume(throwing: CancellationError())
        self.continuation = nil
    }
}

@MainActor
private final class DashboardAppLinkRecorder: NSObject, WKScriptMessageHandler {
    var urls: [String] = []
    let received = DashboardEventSignal()

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        #expect(message.world === DashboardAppLinkMessageHandler.world)
        #expect(message.frameInfo.isMainFrame)
        if let url = message.body as? String { self.urls.append(url) }
        self.received.fire()
    }
}

/// Resumes after WebKit finishes the dashboard load. WebKit publishes `isLoading`
/// and calls the controller's `didFinish` in the same main-thread turn, so the
/// controller has settled before the waiting task resumes. No wall-clock deadline:
/// shared main-actor load in the native suite cannot fail this wait.
@MainActor
private final class DashboardLoadCompletion {
    private let finished = DashboardEventSignal()
    private var sawLoading = false

    func wait(for webView: WKWebView, _ start: () -> Void) async throws {
        let observation = webView.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            MainActor.assumeIsolated { self?.update(isLoading: webView.isLoading) }
        }
        defer { observation.invalidate() }
        start()
        try await self.finished.wait()
    }

    private func update(isLoading: Bool) {
        if isLoading {
            self.sawLoading = true
        } else if self.sawLoading {
            self.finished.fire()
        }
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
        try await DashboardLoadCompletion().wait(for: controller.webView) {
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
        try await recorder.received.wait()
        #expect(recorder.urls == ["openclaw://dashboard"])
    }
}
