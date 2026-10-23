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

@Suite(.serialized)
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
    ])
    func `WK challenge replies are owned by the native socket and current dashboard document`(
        _ transition: String) async throws
    {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
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
    }
}
