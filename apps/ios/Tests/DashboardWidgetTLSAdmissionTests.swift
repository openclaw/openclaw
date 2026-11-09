import Foundation
import OpenClawKit
import Testing
import WebKit
import XCTest
@testable import OpenClaw

struct DashboardWidgetTLSAdmissionTests {
    private let key = "agent:main:lobby-test"
    private let pin = String(repeating: "a", count: 64)

    @Test @MainActor func `only the exact authenticated board sandbox gets the existing certificate pin`() throws {
        let snapshot = try JSONDecoder().decode(
            DashboardWidgetSandboxSnapshot.self,
            from: Data(#"{"sessionKey":"agent:main:lobby-test","widgets":[{"sandboxPort":18997}]}"#.utf8))
        let gateway = try #require(URL(string: "https://gateway.example:18996/focus/dashboard/main/~key/lobby-test"))
        let parameters = try #require(snapshot.pinnedParameters(
            sessionKey: self.key,
            gatewayURL: gateway,
            fingerprint: self.pin,
            host: "GATEWAY.EXAMPLE",
            port: 18997))
        #expect(parameters.required)
        #expect(parameters.expectedFingerprint == self.pin)
        #expect(!parameters.allowTOFU)
        #expect(parameters.storeKey == nil)
        // Main-frame navigation and HTTP Basic still use only the original authority.
        let coordinator = AuthenticatedControlUIWebViewCoordinator(url: gateway, tls: parameters)
        #expect(!coordinator.matchesExpectedAuthority(host: "gateway.example", port: 18997))
    }

    @Test(arguments: ["host", "port", "session", "http", "no-pin", "bad-pin", "external-origin", "no-widget"])
    func `unrelated or unpinned sandbox challenges do not inherit trust`(_ scenario: String) throws {
        let snapshot = DashboardWidgetSandboxSnapshot(
            sessionKey: scenario == "session" ? "agent:other:private" : self.key,
            widgets: scenario == "no-widget" ? [] : [.init(
                sandboxPort: 18997,
                sandboxOrigin: scenario == "external-origin" ? "https://widgets.example" : nil)])
        let gateway = try #require(URL(string: "\(scenario == "http" ? "http" : "https")://gateway.example:18996"))
        let fingerprint = scenario == "no-pin" ? nil : scenario == "bad-pin" ? "invalid" : self.pin
        #expect(snapshot.pinnedParameters(
            sessionKey: self.key,
            gatewayURL: gateway,
            fingerprint: fingerprint,
            host: scenario == "host" ? "unrelated.example" : "gateway.example",
            port: scenario == "port" ? 18998 : 18997) == nil)
    }

    @Test func `global boards retain their explicit owner in the projected response`() throws {
        let snapshot = DashboardWidgetSandboxSnapshot(
            sessionKey: "agent:research:global", widgets: [.init(sandboxPort: 18997, sandboxOrigin: nil)])
        let url = try #require(URL(string: "https://gateway.example:18996"))
        #expect(snapshot.pinnedParameters(
            sessionKey: "global",
            agentID: "research",
            gatewayURL: url,
            fingerprint: self.pin,
            host: "gateway.example",
            port: 18997) != nil)
        #expect(snapshot.pinnedParameters(
            sessionKey: "global",
            agentID: "main",
            gatewayURL: url,
            fingerprint: self.pin,
            host: "gateway.example",
            port: 18997) == nil)
    }

    @Test @MainActor func `real WebKit sandbox challenges enforce the pin and current admission`() async throws {
        for scenario in ["match", "mismatch", "retired"] {
            let sandbox = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
            defer { sandbox.stop() }
            sandbox.httpResponse = { _ in .init(status: 200, body: Data("Widget".utf8)) }
            let fingerprint = try #require(sandbox.fingerprint)
            let pin = scenario == "mismatch" ? String(repeating: "f", count: 64) : fingerprint
            let tls = GatewayTLSParams(required: true, expectedFingerprint: pin, allowTOFU: false, storeKey: nil)
            let handled = XCTestExpectation(description: "Sandbox TLS challenge handled")
            let pageURL = try #require(URL(string: "https://127.0.0.1:18996/focus/dashboard/main/test"))
            let coordinator = AuthenticatedControlUIWebViewCoordinator(
                url: pageURL,
                tls: tls,
                widgetSandboxTLSProvider: { host, port in
                    #expect(host == "127.0.0.1")
                    #expect(port == Int(sandbox.port))
                    await Task.yield()
                    return DashboardWidgetTLSAdmission(parameters: tls, isCurrent: { scenario != "retired" })
                })
            let delegate = DashboardWidgetTLSFixtureDelegate(coordinator: coordinator, handled: handled)
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = delegate
            defer {
                webView.stopLoading()
                webView.navigationDelegate = nil
            }
            let url = "https://127.0.0.1:\(sandbox.port)/sandbox"
            webView.loadHTMLString("<iframe src='\(url)'></iframe>", baseURL: pageURL)
            #expect(await XCTWaiter.fulfillment(of: [handled], timeout: 5) == .completed)
            #expect(delegate.disposition == (scenario == "match" ? .useCredential : .cancelAuthenticationChallenge))
        }
    }
}

@MainActor
private final class DashboardWidgetTLSFixtureDelegate: NSObject, WKNavigationDelegate {
    let coordinator: AuthenticatedControlUIWebViewCoordinator
    let handled: XCTestExpectation
    var disposition: URLSession.AuthChallengeDisposition?

    init(coordinator: AuthenticatedControlUIWebViewCoordinator, handled: XCTestExpectation) {
        self.coordinator = coordinator
        self.handled = handled
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        self.coordinator.webView(webView, didReceive: challenge) { disposition, credential in
            self.disposition = disposition
            completionHandler(disposition, credential)
            self.handled.fulfill()
        }
    }
}
