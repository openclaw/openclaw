import Foundation
import Network
import Testing
import WebKit
@testable import OpenClaw

/// Checks the pieces of the Access Dashboard seed that only live WebKit can confirm.
@MainActor
struct CloudflareAccessWebKitTests {
    private func cookie(origin: String) throws -> CloudflareAccessWebCookie {
        let application = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: origin))),
            issuer: #require(URL(string: "https://example.cloudflareaccess.com")),
            audience: "test-audience")
        let session = CloudflareAccessSession(
            application: application,
            subject: "test-subject",
            token: "header.payload.signature",
            expiresAt: Date().addingTimeInterval(3600))
        let pageURL = try #require(URL(string: origin + "/settings"))
        let decision = CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true)
        return try #require(decision.cookie)
    }

    @Test func `WebKit accepts the port block rules for default and explicit ports`() async throws {
        let store = try #require(WKContentRuleListStore.default())
        for (index, origin) in ["https://gateway.example.test", "https://gateway.example.test:8443"].enumerated() {
            let rules = try #require(CloudflareAccessWebSession.otherAuthorityBlockRules(
                for: self.cookie(origin: origin).origin))
            let identifier = "ai.openclaw.access.test.\(UUID().uuidString)-\(index)"
            let list = try await store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: rules)
            #expect(list != nil)
            try await store.removeContentRuleList(forIdentifier: identifier)
        }
    }

    @Test func `a nonpersistent WebKit store keeps the cookie host only secure and HttpOnly`() async throws {
        let cookie = try self.cookie(origin: "https://gateway.example.test:8443")
        let http = try #require(cookie.httpCookie())
        let dataStore = WKWebsiteDataStore.nonPersistent()
        await dataStore.httpCookieStore.setCookie(http)
        let stored = await dataStore.httpCookieStore.allCookies()
        let match = try #require(stored.first { $0.name == CloudflareAccessWebCookie.name })
        #expect(match.domain == "gateway.example.test")
        #expect(!match.domain.hasPrefix("."))
        #expect(match.isSecure)
        #expect(match.isHTTPOnly)
        #expect(match.path == "/")
        await dataStore.httpCookieStore.deleteCookie(match)
        #expect(await dataStore.httpCookieStore.allCookies().isEmpty)
    }

    @Test func `WebKit blocks other ports on the gateway host and still loads the admitted one`() async throws {
        let other = try LocalServer(body: "other service")
        let otherPort = try await other.start()
        let admitted = try LocalServer(body: """
        <html><body><img src="http://127.0.0.1:\(otherPort)/pixel.png">\
        <iframe src="http://127.0.0.1:\(otherPort)/frame"></iframe>\
        <script>fetch("http://127.0.0.1:\(otherPort)/xhr", {mode: "no-cors"}).catch(() => {});</script>\
        </body></html>
        """)
        let admittedPort = try await admitted.start()
        defer {
            other.stop()
            admitted.stop()
        }

        // Control: without rules the other port is reachable, so the check below can detect a leak.
        try await self.load(admittedPort: admittedPort, rules: nil)
        try await self.waitFor { other.requestCount > 0 }
        #expect(other.requestCount > 0)

        let before = other.requestCount
        let admittedBefore = admitted.requestCount
        let rules = try #require(CloudflareAccessWebSession.blockRules(
            host: "127.0.0.1", port: Int(admittedPort), webScheme: "http", socketScheme: "ws"))
        try await self.load(admittedPort: admittedPort, rules: rules)
        try await Task.sleep(for: .seconds(1.5))
        #expect(other.requestCount == before)
        #expect(admitted.requestCount > admittedBefore)
    }

    private func load(admittedPort: UInt16, rules: String?) async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if let rules {
            let identifier = "ai.openclaw.access.test.\(UUID().uuidString)"
            let list = try #require(try await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: identifier, encodedContentRuleList: rules))
            configuration.userContentController.add(list)
        }
        let webView = WKWebView(frame: .init(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        let delegate = LoadWaiter()
        webView.navigationDelegate = delegate
        try await delegate.load(webView, URL(string: "http://127.0.0.1:\(admittedPort)/page")!)
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<60 where !condition() {
            try await Task.sleep(for: .milliseconds(100))
        }
    }
}

@MainActor
private final class LoadWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, any Error>?

    func load(_ webView: WKWebView, _ url: URL) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.load(URLRequest(url: url))
        }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation!) {
        self.continuation?.resume()
        self.continuation = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: any Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }
}

/// Answers every request on a loopback port and counts them.
@MainActor
private final class LocalServer {
    private let listener: NWListener
    private let response: Data
    private var connections: [NWConnection] = []
    private(set) var requestCount = 0

    init(body: String) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        let payload = Data(body.utf8)
        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: \(payload.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        self.response = Data(header.utf8) + payload
        self.listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor [weak self] in self?.accept(connection) }
        }
    }

    func start() async throws -> UInt16 {
        self.listener.start(queue: .main)
        for _ in 0..<50 {
            if case .ready = self.listener.state, let port = self.listener.port { return port.rawValue }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw URLError(.cannotConnectToHost)
    }

    func stop() {
        self.listener.cancel()
        for connection in self.connections {
            connection.cancel()
        }
    }

    private func accept(_ connection: NWConnection) {
        self.connections.append(connection)
        connection.start(queue: .main)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            Task { @MainActor [weak self] in
                guard let self, data != nil else { return }
                self.requestCount += 1
                connection.send(content: self.response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }
}
