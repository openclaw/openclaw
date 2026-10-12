import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct DashboardFailurePageTests {
    @Test(arguments: ["ws", "wss", "https", "WSS", "HTTPS"])
    func `connection repair prompt redacts credentials in both the address and error`(scheme: String) throws {
        let endpoint = try #require(URL(string:
            "\(scheme)://synthetic-user':synthetic-password'@gateway.example:8447/control?token=synthetic-query'#synthetic-fragment'"))
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse, userInfo: [
            NSLocalizedDescriptionKey: "connect to gateway @ \(endpoint.absoluteString): bad server response",
        ])
        let html = DashboardFailurePage.html(connectionError: error, url: endpoint)
        #expect(html.lowercased().contains("\(scheme.lowercased())://gateway.example:8447/control"))
        #expect(html.contains("bad server response"))
        let containsCredential = ["synthetic-user", "synthetic-password", "synthetic-query", "synthetic-fragment"]
            .contains { html.contains($0) }
        #expect(!containsCredential)
    }

    @Test func `connection repair prompt escapes error text without ending the text field`() throws {
        let error = NSError(domain: "Fixture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Failed </textarea><script>alert('fixture')</script> & offline",
        ])
        let html = DashboardFailurePage.html(connectionError: error, url: URL(string: "about:blank"))
        #expect(html.contains("Failed &lt;/textarea&gt;&lt;script&gt;alert(&#39;fixture&#39;)&lt;/script&gt; &amp; offline"))
        #expect(!html.contains("<script>"))
        #expect(!html.contains("about:blank"))
    }

    @Test(arguments: [false, true])
    func `signed out page escapes profile metadata and offers renewal`(signingIn: Bool) {
        let now = Date(timeIntervalSince1970: 10000)
        let page = DashboardFailurePage.SignedOut(
            target: .profile("test\"'&<>"), name: "Research <&>\"'", host: "gateway.example",
            expiresAt: now.addingTimeInterval(-120))
        let html = DashboardFailurePage.html(
            signedOut: page, signingIn: signingIn, error: "Failed <script>&\"'", now: now)
        #expect(html.contains("Signed out of Research &lt;&amp;&gt;&quot;&#39;"))
        #expect(html.contains("Your browser sign-in to gateway.example expired 2m ago. Sign in again to continue."))
        #expect(html.contains("Connection Settings…"))
        #expect(html.contains("data-id=\"profile:test&quot;&#39;&amp;&lt;&gt;\""))
        #expect(!html.contains("<script>"))
        if signingIn {
            #expect(html.contains(">Cancel</button>"))
            #expect(html.contains("type:'reconnect-cancel',id:this.dataset.id"))
        } else {
            #expect(html.contains(">Sign in again</button>"))
            #expect(html.contains("type:'reconnect',id:this.dataset.id"))
            #expect(html.contains("Failed &lt;script&gt;&amp;&quot;&#39;"))
        }
        #expect(html.contains("Failed &lt;script&gt;&amp;&quot;&#39;"))
    }

    @Test(arguments: [false, true], [false, true])
    func `browser recovery is available only during the current sign in`(signingIn: Bool, available: Bool) {
        let page = DashboardFailurePage.SignedOut(
            target: .profile("fixture"), name: "Fixture", host: "gateway.example", expiresAt: .distantPast)
        let html = DashboardFailurePage.html(
            signedOut: page, signingIn: signingIn, browserAttempt: available ? UUID() : nil)
        #expect(html.contains(">Open browser</button>") == (signingIn && available))
        #expect(html.contains("reconnect-browser") == (signingIn && available))
        #expect(!html.contains("redirect_url"))
        #expect(!html.contains("edge_token_transfer"))
    }

    @Test func `renewal page does not claim a future expiry already happened`() {
        let now = Date(timeIntervalSince1970: 10000)
        let page = DashboardFailurePage.SignedOut(
            target: .profile("test"), name: "Research", host: "gateway.example",
            expiresAt: now.addingTimeInterval(900))
        let html = DashboardFailurePage.html(signedOut: page, now: now)
        #expect(html.contains("Your browser sign-in to gateway.example expires soon. Sign in again to continue."))
        #expect(html.contains(">Sign in again</button>"))
    }

    @Test(arguments: [false, true], [false, true])
    func `dashboard diagnostics omit authentication while retaining the endpoint`(
        fragmentAuth: Bool,
        userInfoAuth: Bool) throws
    {
        let token = UUID().uuidString
        let username = UUID().uuidString
        let password = UUID().uuidString
        var endpoint = try #require(URLComponents(string: "wss://gateway.example.invalid:443/control"))
        endpoint.user = userInfoAuth ? username : nil
        endpoint.password = userInfoAuth ? password : nil
        let endpointURL = try #require(endpoint.url)
        let url = try GatewayEndpointStore.dashboardURL(
            for: (endpointURL, fragmentAuth ? token : nil, nil),
            mode: .remote)
        let html = DashboardFailurePage.html(
            title: "Dashboard unavailable",
            message: "Could not connect to the server.",
            detail: nil,
            url: url)
        let displayedEndpoint = "https://gateway.example.invalid:443/control/"

        // Boolean assertions keep even synthetic credential values out of failure diagnostics.
        let pageHasEndpoint = html.contains("<code>\(displayedEndpoint)</code>")
        let pageHasCredential = [token, username, password].contains { html.contains($0) }
        let logHasOnlyEndpoint = GatewayEndpointStore.diagnosticURLString(for: url) == displayedEndpoint
        #expect(pageHasEndpoint)
        #expect(!pageHasCredential)
        #expect(logHasOnlyEndpoint)

        let retainsFragment = (url.fragment?.contains(token) == true) == fragmentAuth
        let retainsUserInfo = (url.user == username && url.password == password) == userInfoAuth
        #expect(retainsFragment)
        #expect(retainsUserInfo)
    }

    @Test(arguments: ["ws", "wss"])
    func `gateway diagnostics preserve websocket schemes`(scheme: String) throws {
        let address = "\(scheme)://127.0.0.1:18789/control/"
        let url = try #require(URL(string: address))
        #expect(GatewayEndpointStore.diagnosticURLString(for: url) == address)
    }
}

struct DashboardBrowserSignInPolicyTests {
    @Test(arguments: [false, true])
    func `endpoint expiry context supplies the page without another profile lookup`(gesture: Bool) throws {
        let url = try #require(URL(string: "wss://gateway.example/operator/"))
        let expiry = Date(timeIntervalSince1970: 10000)
        let context = MacGatewayProfileStore.BrowserSignInRequired(
            profile: MacGatewayProfile(id: "research", name: "Research", url: url), expiresAt: expiry)
        let configuration = try #require(try DashboardManager.WindowConfiguration(
            signedOut: context, profileID: "research", name: nil, endpoint: nil, userGesture: gesture))

        #expect(configuration.signedOut == DashboardFailurePage.SignedOut(
            target: .profile("research"), name: "Research", host: "gateway.example", expiresAt: expiry))
        #expect(configuration.url.absoluteString == "https://gateway.example/operator/")
        #expect(configuration.autoStartSignIn == gesture)
        #expect(!configuration.auth.hasCredential)
        #expect(configuration.browserSession == nil)
        #expect(try DashboardManager.WindowConfiguration(
            signedOut: context, profileID: "other", name: nil, endpoint: nil, userGesture: gesture) == nil)
    }

    @Test func `injected browser endpoint supplies local expiry facts without credentials on the page`() throws {
        let url = try #require(URL(string: "wss://gateway.example/operator/"))
        let expiry = Date(timeIntervalSince1970: 10000)
        let session = try GatewayBrowserSession(
            origin: #require(URL(string: "https://gateway.example/")),
            issuer: #require(URL(string: "https://issuer.example/")),
            audience: "fixture", subject: "fixture", token: "synthetic", expiresAt: expiry)
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url, "synthetic-token", "synthetic-password"), routeAuthority: nil, browserSession: session)
        let configuration = try #require(try DashboardManager.WindowConfiguration(
            signedOut: GatewayBrowserSessionError.expired, profileID: "research", name: "Catalog name",
            endpoint: endpoint, userGesture: true))

        #expect(configuration.signedOut?.name == "Catalog name")
        #expect(configuration.signedOut?.expiresAt == expiry)
        #expect(configuration.url.absoluteString == "https://gateway.example/operator/")
        #expect(!configuration.auth.hasCredential)
        #expect(configuration.browserSession == nil)
        #expect(try DashboardManager.WindowConfiguration(
            signedOut: GatewayBrowserSessionError.wrongOrigin, profileID: "research", name: nil,
            endpoint: endpoint, userGesture: true) == nil)
        #expect(try DashboardManager.WindowConfiguration(
            signedOut: GatewayBrowserSessionError.expired, profileID: "research", name: nil,
            endpoint: nil, userGesture: true) == nil)
    }
}
