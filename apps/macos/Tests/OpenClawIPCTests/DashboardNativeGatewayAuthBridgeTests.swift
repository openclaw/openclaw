import AppKit
import ConcurrencyExtras
import Foundation
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
func waitForNativeDashboardDocument(_ controller: DashboardWindowController) async throws {
    try await waitForNativeDashboardDocument(webView: controller.webView, dashboardURL: controller.currentURL)
}

@MainActor
func waitForNativeDashboardDocument(webView: WKWebView, dashboardURL: URL) async throws {
    let events = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let observation = webView.observe(\.isLoading, options: [.initial, .new]) { _, _ in
        events.continuation.yield(())
    }
    defer {
        observation.invalidate()
        events.continuation.finish()
    }
    try await AsyncTimeout.withTimeout(seconds: 5, onTimeout: { URLError(.timedOut) }) {
        for await _ in events.stream {
            let ready = await MainActor.run {
                !webView.isLoading &&
                    ControlUIDocumentHost.isTrustedLinkSource(webView.url, dashboardURL: dashboardURL)
            }
            if ready { return }
        }
        throw CancellationError()
    }
}

@MainActor
func dashboardNativeAuthSnapshot(_ controller: DashboardWindowController) async throws -> [String: Any] {
    try await waitForNativeDashboardDocument(controller)
    return try #require(try await controller.webView.evaluateJavaScript(
        "window.__OPENCLAW_NATIVE_CONTROL_AUTH__") as? [String: Any])
}

/// WebKit callbacks do not inherit the test task's identity directory. Keep
/// the real provider and its live validity checks inside the same private fixture.
@MainActor
func scopeNativeDashboardIdentity(_ document: ControlUIDocumentHost, stateDirectory: URL) throws {
    let provider = try #require(document.nativeGatewayAuthProvider)
    document.nativeGatewayAuthProvider = { nonce, signedAt in
        let response = try await DeviceIdentityStore.withStateDirectory(stateDirectory) {
            try await provider(nonce, signedAt)
        }
        return DashboardNativeGatewayAuth(json: response.json, isCurrent: {
            DeviceIdentityPaths.$scopedStateDirURL.withValue(stateDirectory) {
                response.isCurrent()
            }
        })
    }
}

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardNativeGatewayAuthBridgeTests {
    @Test(arguments: ["subframe", "untrusted-path", "browser-identity"])
    func `untrusted frames and browser identity documents cannot request native credentials`(
        _ source: String) async throws
    {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            contentSecurityPolicy: "default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url("/control/"),
            auth: source == "browser-identity"
                ? .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
                : .nativeDevice(gatewayUrl: server.websocketURL().absoluteString, token: "secret", password: nil),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let calls = LockIsolated(0)
        controller.documentHost.nativeGatewayAuthProvider = { _, _ in
            calls.withValue { $0 += 1 }
            throw CancellationError()
        }
        controller.show(url: controller.currentURL, auth: controller.auth)
        try await waitForNativeDashboardDocument(controller)
        if source == "untrusted-path" {
            _ = try await controller.webView.evaluateJavaScript("history.pushState({}, '', '/outside')")
        }
        let value = try await controller.webView.callAsyncJavaScript("""
        const request = `window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
          id:'request', nonce:'challenge', signedAt:123
        }).then(value => { parent.finishNativeReply(value); },
                error => { parent.finishNativeReply({rejected:true}); });`;
        if (!subframe) {
          try {
            return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
              id:'request', nonce:'challenge', signedAt:123
            });
          } catch (error) { return {rejected:true}; }
        }
        return await new Promise(resolve => {
          window.finishNativeReply = resolve;
          const frame = document.createElement('iframe');
          frame.srcdoc = '<html><body><script>' + request + '</script></body></html>';
          document.body.append(frame);
        });
        """, arguments: ["subframe": source == "subframe"], in: nil, contentWorld: .page)
        let reply = try #require(value as? [String: Any])
        #expect(reply["rejected"] as? Bool == true)
        #expect(calls.value == 0)
    }

    @Test(arguments: [
        "current",
        "current-password",
        "current-device-only",
        "document",
        "provider",
        "socket",
        "browser-identity",
        "close",
        "replacement",
        "immediate-reopen",
    ])
    func `WK challenge replies are owned by the native socket and current dashboard document`(
        _ transition: String) async throws
    {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            html: "<html><script>window.nativeAuthDocument = crypto.randomUUID();</script></html>",
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url("/control/"),
            auth: .nativeDevice(
                gatewayUrl: server.websocketURL("/control/").absoluteString,
                token: "must-not-be-injected", password: "must-not-be-injected-either",
                legacyCredentials: transition == "current-password"
                    ? ["password": "accepted-legacy-password"]
                    : transition == "current-device-only" ? [:] : ["token": "accepted-legacy-token"]),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let requested = AsyncTestGate()
        let release = AsyncTestGate()
        defer { release.open() }
        let current = LockIsolated(true)
        controller.documentHost.nativeGatewayAuthProvider = { nonce, signedAt in
            #expect(nonce == "challenge")
            #expect(signedAt > 0)
            requested.open()
            await release.wait()
            return DashboardNativeGatewayAuth(
                json: Data(#"{"auth":{"deviceToken":"native-grant"},"scopes":["operator.read"]}"#.utf8),
                isCurrent: { current.value })
        }
        controller.show(url: controller.currentURL, auth: controller.auth)
        let bootstrap = try await dashboardNativeAuthSnapshot(controller)
        #expect(bootstrap["nativeConnectAuth"] as? Bool == true)
        if transition == "current-password" {
            #expect(bootstrap["token"] is NSNull)
            #expect(bootstrap["password"] as? String == "accepted-legacy-password")
        } else if transition == "current-device-only" {
            #expect(bootstrap["token"] == nil)
            #expect(bootstrap["password"] == nil)
        } else {
            #expect(bootstrap["token"] as? String == "accepted-legacy-token")
            #expect(bootstrap["password"] == nil)
        }
        #expect(controller.currentURL.fragment == nil)
        let sourceDocument = try #require(try await controller.webView.evaluateJavaScript(
            "window.nativeAuthDocument") as? String)
        let holdsRetiredPage = ["close", "replacement", "immediate-reopen"].contains(transition)
        let retirement = DashboardRetirementNavigation()
        retirement.blockAllNavigation = transition == "immediate-reopen"
        var replacementWindow: NSWindow?
        var currentRecipient: DashboardWindowController?
        defer {
            currentRecipient?.closeDashboard()
            if currentRecipient == nil { replacementWindow?.close() }
        }
        if holdsRetiredPage {
            controller.webView.navigationDelegate = retirement
        }
        defer {
            if holdsRetiredPage {
                controller.webView.navigationDelegate = nil
                controller.webView.loadHTMLString("", baseURL: nil)
            }
            withExtendedLifetime(retirement) {}
        }
        let pending = Task {
            try await controller.webView.callAsyncJavaScript("""
            try {
              return JSON.stringify(await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                id: 'request', nonce: 'challenge', signedAt:123
              }));
            } catch (error) { return JSON.stringify({error:String(error)}); }
            """, in: nil, contentWorld: .page) as? String
        }
        do {
            try await AsyncTimeout.withTimeout(
                seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await requested.wait() })
            switch transition {
            case "document": controller.webView(controller.webView, didCommit: nil)
            case "provider": controller.documentHost.nativeGatewayAuthProvider = nil
            case "socket": current.setValue(false)
            case "close": controller.closeDashboard()
            case "replacement": replacementWindow = try #require(controller.detachWindowForReplacement())
            case "immediate-reopen":
                controller.closeDashboard()
                controller.show()
                #expect(controller.isWindowOpen)
            case "browser-identity": controller
                .auth = .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
            default: break
            }
            release.open()
        } catch {
            release.open()
            _ = await pending.result
            throw error
        }
        let json = try #require(try await pending.value)
        let received = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        if transition.hasPrefix("current") {
            let result = try #require(received["result"] as? [String: Any])
            #expect((result["auth"] as? [String: String])?["deviceToken"] == "native-grant")
            #expect(received["id"] as? String == "request")
        } else {
            #expect(received["error"] as? String != nil)
            #expect(received["result"] == nil)
        }
        print("""
        [native-auth-proof] transition=\(transition) result=\(received["result"] != nil) \
        error=\(received["error"] != nil)
        """)
        if holdsRetiredPage {
            let currentController: DashboardWindowController
            if transition == "immediate-reopen" {
                // Observe denial in the resident retired page before committing a real new document.
                retirement.blockAllNavigation = false
                controller.webView.navigationDelegate = controller
                controller.reloadDashboard()
                currentController = controller
            } else {
                let current = DashboardWindowController(
                    url: server.url("/control/"), auth: controller.auth,
                    websiteDataStore: .nonPersistent(), windowAutosaveName: "",
                    reusingWindow: replacementWindow, requestBrowserProfileImportOffer: { _ in false })
                currentRecipient = current
                current.documentHost.nativeGatewayAuthProvider = controller.documentHost.nativeGatewayAuthProvider
                current.show(url: current.currentURL, auth: current.auth)
                currentController = current
            }
            try await DashboardTestWait.document(currentController, "current native credential recipient") {
                guard let document = try await currentController.webView.evaluateJavaScript(
                    "window.nativeAuthDocument") as? String
                else { return false }
                return document != sourceDocument
            }
            let fresh = try #require(try await currentController.webView.callAsyncJavaScript("""
            return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
              id:'request-current', nonce:'challenge', signedAt:123
            });
            """, in: nil, contentWorld: .page) as? [String: Any])
            #expect(fresh["id"] as? String == "request-current")
            let result = try #require(fresh["result"] as? [String: Any])
            #expect((result["auth"] as? [String: String])?["deviceToken"] == "native-grant")
            print("[native-auth-proof] transition=\(transition) current-recipient=new-document completed")
        }
    }
}

@MainActor
extension DashboardNativeGatewayAuthBridgeTests {
    @Test(arguments: [false, true])
    func retainedClosedDashboardUnloadsAndReopensItsTrustedRoute(reopenImmediately: Bool) async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><body><script>
            window.fixtureDocument = crypto.randomUUID();
            </script></body></html>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let auth = DashboardWindowAuth.nativeDevice(
            gatewayUrl: server.websocketURL("/control/").absoluteString,
            token: nil, password: nil)
        let controller = DashboardWindowController(
            url: server.url("/control/"), auth: auth,
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        let other = DashboardWindowController(
            url: server.url("/control/"), auth: auth,
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer {
            controller.closeDashboard()
            other.closeDashboard()
        }
        let calls = LockIsolated(0)
        for document in [controller.documentHost, other.documentHost] {
            document.nativeGatewayAuthProvider = { _, _ in
                calls.withValue { $0 += 1 }
                return DashboardNativeGatewayAuth(
                    json: Data(#"{"auth":{"deviceToken":"synthetic-grant"}}"#.utf8), isCurrent: { true })
            }
        }
        controller.show(url: controller.currentURL, auth: auth)
        other.show(url: other.currentURL, auth: auth)
        try await waitForNativeDashboardDocument(controller)
        try await waitForNativeDashboardDocument(other)
        let window = try #require(controller.window)
        let webView = controller.webView
        let original = try #require(try await webView.evaluateJavaScript("window.fixtureDocument") as? String)
        let otherDocument = try #require(try await other.webView.evaluateJavaScript("window.fixtureDocument") as? String)
        _ = try await webView.evaluateJavaScript("""
        history.replaceState({}, '', '/control/chat/main/main?panel=privacy');
        sessionStorage.setItem('closed-dashboard-draft', 'keep this draft');
        """)
        let route = try #require(webView.url)
        let grantScript = """
        return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
          id:'lifecycle-request', nonce:'lifecycle-challenge', signedAt:123
        });
        """
        _ = try await webView.callAsyncJavaScript(grantScript, in: nil, contentWorld: .page)

        // Experience hiding is not retirement: its document and native owner remain available.
        controller.hideForExperience()
        #expect(try await webView.evaluateJavaScript("window.fixtureDocument") as? String == original)
        _ = try await webView.callAsyncJavaScript(grantScript, in: nil, contentWorld: .page)
        controller.show()
        window.performClose(nil)
        #expect(!controller.isWindowOpen)
        #expect(!controller.canDeliverNativeCommands)
        if reopenImmediately {
            controller.show()
        } else {
            try await TestWait.state("closed dashboard document retired") {
                !webView.isLoading && webView.url?.absoluteString == "about:blank"
            }
            // No old document remains to run native-auth reconnect timers, even though its controller is retained.
            #expect(try await webView.evaluateJavaScript("typeof window.fixtureDocument") as? String == "undefined")
            #expect(!controller.canDeliverNativeCommands)
        }
        _ = try await other.webView.callAsyncJavaScript(grantScript, in: nil, contentWorld: .page)
        #expect(try await other.webView.evaluateJavaScript("window.fixtureDocument") as? String == otherDocument)

        // The same native shell and storage reopen without depending on the blank load completing first.
        if !reopenImmediately { controller.show(url: controller.currentURL, auth: auth) }
        try await waitForNativeDashboardDocument(controller)
        #expect(controller.window === window)
        #expect(controller.webView === webView)
        #expect(webView.url == route)
        #expect(try await webView.evaluateJavaScript("window.fixtureDocument") as? String != original)
        #expect(try await webView.evaluateJavaScript(
            "sessionStorage.getItem('closed-dashboard-draft')") as? String == "keep this draft")
        let reply = try #require(try await webView.callAsyncJavaScript(
            grantScript, in: nil, contentWorld: .page) as? [String: Any])
        #expect(reply["result"] != nil)
        #expect(calls.value == 4)
        print("[native-auth-proof] close-reopen immediate=\(reopenImmediately) completed")
    }

    @Test func replacingNativeDashboardRetiresItsOutgoingDocument() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            html: "<html><script>window.retiredFixture = true;</script></html>",
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let auth = DashboardWindowAuth.nativeDevice(
            gatewayUrl: server.websocketURL().absoluteString, token: nil, password: nil)
        let original = DashboardWindowController(
            url: server.url(), auth: auth, websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { original.closeDashboard() }
        original.show(url: server.url(), auth: auth)
        try await waitForNativeDashboardDocument(original)
        let window = try #require(original.detachWindowForReplacement())
        let replacement = DashboardWindowController(
            url: server.url(), auth: auth, websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            reusingWindow: window, requestBrowserProfileImportOffer: { _ in false })
        defer { replacement.closeDashboard() }
        replacement.show(url: server.url(), auth: auth)
        try await waitForNativeDashboardDocument(replacement)
        try await TestWait.state("replaced native document retired") {
            !original.webView.isLoading && original.webView.url?.absoluteString == "about:blank"
        }
        #expect(original.window == nil)
        #expect(!original.canDeliverNativeCommands)
        #expect(try await original.webView.evaluateJavaScript("typeof window.retiredFixture") as? String == "undefined")
        #expect(replacement.window === window)
        #expect(replacement.canDeliverNativeCommands)
        print("[native-auth-proof] replacement-unload completed")
    }
}
