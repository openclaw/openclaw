import CryptoKit
import Foundation
import Network
import OpenClawKit
import Security
import SwiftUI
import Testing
import WebKit
@testable import OpenClaw

@MainActor
struct SettingsProxyAuthenticationTests {
    @Test(.timeLimit(.minutes(1)))
    func `embedded Settings authenticates its document resources and WebSocket using stored Basic credentials`() async throws {
        let identity = try Self.fixtureIdentity()
        var authorizedTargets: Set<String> = []
        var observedCredentials: [String: [String]] = [:]
        let authorization = "Basic " + Data("fixture:synthetic-password".utf8).base64EncodedString()
        var expectedAuthorization = authorization
        let server = try await DashboardHTTPFixture.start(
            tlsIdentity: identity.network,
            rawResponseHandler: { request in
                let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                let headers = request.components(separatedBy: "\r\n").dropFirst().reduce(into: [String: String]()) {
                    headers, line in
                    let parts = line.split(separator: ":", maxSplits: 1)
                    if parts.count == 2 {
                        headers[String(parts[0]).lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
                    }
                }
                observedCredentials[target, default: []].append(headers["authorization"] ?? "")
                guard headers["authorization"] == expectedAuthorization else {
                    return Self.response(
                        status: "401 Unauthorized",
                        headers: "WWW-Authenticate: Basic realm=\"fixture\"\r\n")
                }
                authorizedTargets.insert(target)
                if let key = headers["sec-websocket-key"] {
                    let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
                    let accept = Data(digest).base64EncodedString()
                    let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Accept: \(accept)\r\n\r\n"
                    return .init(data: Data(head.utf8) + Data([0x81, 0x02, 0x6F, 0x6B]), keepConnectionOpen: true)
                }
                if target == "/resource.js" {
                    return Self.response(contentType: "text/javascript", body: "window.resourceLoaded = true;")
                }
                if target.hasPrefix("/probe-") { return Self.response(body: "ok") }
                return Self.response(body: """
                <!doctype html><script src="/resource.js"></script><script>
                window.socketResult = 'pending';
                const socket = new WebSocket('wss://' + location.host + '/socket');
                socket.onmessage = () => { window.socketResult = 'ok'; socket.close(); };
                socket.onerror = () => { window.socketResult = 'error'; };
                </script><main>Settings fixture</main>
                """)
            })
        defer { server.stop() }
        let config = Self.config(url: server.websocketURL(), tls: identity.pin)
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["Authorization": authorization], gatewayStableID: config.effectiveStableID))
        defer { _ = GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: config.effectiveStableID) }

        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let gateway = GatewayConnectionController(appModel: model, startDiscovery: false)
        let view = EmbeddedDashboardContent(
            appModel: model,
            appearanceModel: AppAppearanceModel(),
            gatewayController: gateway,
            url: server.url("/settings"),
            config: config,
            openPanel: { _ in })
        let controller = UIHostingController(rootView: view)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.view.layoutIfNeeded()
        var loadedWebView: WKWebView?
        try await TestWait.state("embedded Settings WebView mounting") {
            loadedWebView = Self.findWebView(in: controller.view)
            return loadedWebView != nil
        }
        let webView = try #require(loadedWebView)
        defer {
            webView.stopLoading()
            webView.navigationDelegate = nil
        }
        try await TestWait.state("Settings document loading") {
            webView.url == server.url("/settings") && !webView.isLoading
        }
        try await TestWait.state("Dashboard WebSocket authentication") {
            try await webView.evaluateJavaScript("window.socketResult !== 'pending'") as? Bool == true
        }
        #expect(try await webView
            .evaluateJavaScript("document.body.textContent.includes('Settings fixture')") as? Bool == true)
        #expect(try await webView.evaluateJavaScript("window.resourceLoaded === true") as? Bool == true)
        #expect(try await webView.evaluateJavaScript("window.socketResult") as? String == "ok")
        #expect(authorizedTargets == ["/settings", "/resource.js", "/socket"])

        // Keep the same document and WebKit network session after changing the real Keychain owner.
        #expect(GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: config.effectiveStableID))
        #expect(try await webView.callAsyncJavaScript(
            "return await fetch('/probe-cleared', {cache: 'no-store'}).then(r => r.status);",
            arguments: [:], in: nil, contentWorld: .page) as? Int == 401)
        #expect(try await Self.probeWebSocket(in: webView, path: "/probe-socket-cleared") == "error")
        for path in ["/probe-cleared", "/probe-socket-cleared"] {
            let credentials = try #require(observedCredentials[path])
            #expect(!credentials.isEmpty && credentials.allSatisfy(\.isEmpty))
        }

        let replacement = "Basic " + Data("replacement:synthetic-second".utf8).base64EncodedString()
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["Authorization": replacement], gatewayStableID: config.effectiveStableID))
        expectedAuthorization = replacement
        #expect(try await webView.callAsyncJavaScript(
            "return await fetch('/probe-replaced', {cache: 'no-store'}).then(r => r.status);",
            arguments: [:], in: nil, contentWorld: .page) as? Int == 200)
        #expect(try await Self.probeWebSocket(in: webView, path: "/probe-socket-replaced") == "ok")
        for path in ["/probe-replaced", "/probe-socket-replaced"] {
            let credentials = try #require(observedCredentials[path])
            #expect(credentials.contains(replacement))
            #expect(!credentials.contains(authorization))
        }
        print("Settings Basic auth transport: document/resource/WebSocket authenticated; " +
            "removed credential absent from HTTP/WebSocket; replacement used without old credential.")
    }

    @Test func `Basic challenge credentials are read only for the configured secure origin and first attempt`() throws {
        let pageURL = try #require(URL(string: "https://gateway.example:8443/settings"))
        let webView = WKWebView()
        let cases: [(
            host: String,
            port: Int,
            scheme: String,
            method: String,
            failures: Int,
            proxy: Bool,
            allowed: Bool)] = [
            ("gateway.example", 8443, "https", NSURLAuthenticationMethodHTTPBasic, 0, false, true),
            ("other.example", 8443, "https", NSURLAuthenticationMethodHTTPBasic, 0, false, false),
            ("gateway.example", 443, "https", NSURLAuthenticationMethodHTTPBasic, 0, false, false),
            ("gateway.example", 8443, "http", NSURLAuthenticationMethodHTTPBasic, 0, false, false),
            ("gateway.example", 8443, "https", NSURLAuthenticationMethodHTTPDigest, 0, false, false),
            ("gateway.example", 8443, "https", NSURLAuthenticationMethodHTTPBasic, 1, false, false),
            ("gateway.example", 8443, "https", NSURLAuthenticationMethodHTTPBasic, 0, true, false),
        ]
        for item in cases {
            var reads = 0
            let coordinator = AuthenticatedControlUIWebViewCoordinator(
                url: pageURL, tls: nil, basicProxyCredentialProvider: {
                    reads += 1
                    return URLCredential(user: "fixture", password: "synthetic", persistence: .none)
                })
            let space = item.proxy ? URLProtectionSpace(
                proxyHost: item.host, port: item.port, type: NSURLProtectionSpaceHTTPSProxy,
                realm: "fixture", authenticationMethod: item.method) : URLProtectionSpace(
                host: item.host, port: item.port, protocol: item.scheme, realm: "fixture",
                authenticationMethod: item.method)
            let challenge = URLAuthenticationChallenge(
                protectionSpace: space, proposedCredential: nil, previousFailureCount: item.failures,
                failureResponse: nil, error: nil, sender: BasicChallengeSender())
            var disposition: URLSession.AuthChallengeDisposition?
            coordinator.webView(webView, didReceive: challenge) { result, credential in
                disposition = result
                #expect((credential != nil) == item.allowed)
                if item.allowed { #expect(credential?.persistence == URLCredential.Persistence.none) }
            }
            #expect(disposition == (item.allowed ? .useCredential : .performDefaultHandling))
            #expect(reads == (item.allowed ? 1 : 0))
        }
    }

    @Test func `Basic credentials follow the existing gateway store without changing other authorization schemes`() throws {
        let config = try Self.config(url: #require(URL(string: "wss://gateway.example:8443")))
        defer { _ = GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: config.effectiveStableID) }
        let cases: [(String, String?, String?)] = [
            ("Basic " + Data("fixture:first:password".utf8).base64EncodedString(), "fixture", "first:password"),
            ("basic " + Data("replacement:second".utf8).base64EncodedString(), "replacement", "second"),
            ("Bearer synthetic", nil, nil),
            ("Basic invalid-base64", nil, nil),
            ("Basic " + Data("missing-separator".utf8).base64EncodedString(), nil, nil),
        ]
        for (header, user, password) in cases {
            #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
                ["authorization": header], gatewayStableID: config.effectiveStableID))
            let credential = AuthenticatedControlUI.basicProxyCredential(config: config)
            #expect(credential?.user == user)
            #expect(credential?.password == password)
        }
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["Authorization": "Basic " + Data("fixture:valid".utf8).base64EncodedString()],
            gatewayStableID: config.effectiveStableID))
        let cleartext = try Self.config(
            url: #require(URL(string: "ws://gateway.example")), stableID: config.effectiveStableID)
        #expect(AuthenticatedControlUI.basicProxyCredential(config: cleartext) == nil)
        let otherGateway = Self.config(url: config.url)
        #expect(AuthenticatedControlUI.basicProxyCredential(config: otherGateway) == nil)
        #expect(AuthenticatedControlUI.basicProxyCredential(config: nil) == nil)
    }

    private static func probeWebSocket(in webView: WKWebView, path: String) async throws -> String? {
        try await webView.callAsyncJavaScript("""
        return await new Promise(resolve => {
          const socket = new WebSocket('wss://' + location.host + path);
          socket.onmessage = () => { socket.close(); resolve('ok'); };
          socket.onerror = () => { socket.close(); resolve('error'); };
        });
        """, arguments: ["path": path], in: nil, contentWorld: .page) as? String
    }

    private static func config(
        url: URL,
        tls: GatewayTLSParams? = nil,
        stableID: String = "settings-proxy-fixture-\(UUID().uuidString)") -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url, stableID: stableID, tls: tls,
            token: nil, bootstrapToken: nil, password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:], clientId: "ios", clientMode: "node",
                clientDisplayName: "Fixture", includeDeviceIdentity: false, allowStoredDeviceAuth: false))
    }

    private static func response(
        status: String = "200 OK", headers: String = "", contentType: String = "text/html", body: String = "")
        -> DashboardHTTPFixture.RawResponse
    {
        let head = "HTTP/1.1 \(status)\r\n" + headers + "Content-Type: \(contentType)\r\n" +
            "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        return .init(data: Data((head + body).utf8))
    }

    private static func fixtureIdentity() throws -> (network: sec_identity_t, pin: GatewayTLSParams) {
        let resource = try #require(Bundle(for: BasicChallengeSender.self)
            .url(forResource: "GatewayIngressIdentity", withExtension: "p12"))
        var items: CFArray?
        try #require(try SecPKCS12Import(Data(contentsOf: resource) as CFData, [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ] as CFDictionary, &items) == errSecSuccess)
        let imported = try #require((items as? [[String: Any]])?.first?[kSecImportItemIdentity as String])
        // Security guarantees this value's type; the fixture does not import into Keychain.
        let identity = imported as! SecIdentity
        let network = try #require(sec_identity_create(identity))
        var certificate: SecCertificate?
        try #require(SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess)
        let bytes = try SecCertificateCopyData(#require(certificate)) as Data
        let pin = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return (network, GatewayTLSParams(required: true, expectedFingerprint: pin, allowTOFU: false, storeKey: nil))
    }

    private static func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        return view.subviews.lazy.compactMap { Self.findWebView(in: $0) }.first
    }
}

private final class BasicChallengeSender: NSObject, URLAuthenticationChallengeSender {
    func use(_: URLCredential, for _: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for _: URLAuthenticationChallenge) {}
    func cancel(_: URLAuthenticationChallenge) {}
}
