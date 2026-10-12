import Foundation
import SwiftUI
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct TerminalHubScreenTests {
    private static func makeConfig(
        url: URL,
        token: String? = nil,
        password: String? = nil,
        tls: GatewayTLSParams? = nil,
        allowStoredDeviceAuth: Bool = true,
        deviceAuthGatewayID: String? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|gateway.example.com|443",
            tls: tls,
            token: token,
            bootstrapToken: nil,
            password: password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone",
                allowStoredDeviceAuth: allowStoredDeviceAuth,
                deviceAuthGatewayID: deviceAuthGatewayID))
    }

    @Test func `terminal URL flips scheme and preserves the Control UI base path`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/openclaw/")),
            token: "secret-token")

        let url = ControlUIHubPage.terminal.url(config: config)

        #expect(url?.absoluteString == "https://gateway.example.com:8443/openclaw/focus/terminal")
        // Credentials must never ride in the page URL; they travel via the
        // document-start auth user script instead.
        #expect(url?.absoluteString.contains("secret-token") == false)
    }

    @Test func `terminal URL uses plain HTTP for insecure endpoints`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "ws://192.168.1.10:18789")))

        let url = ControlUIHubPage.terminal.url(config: config)

        #expect(url?.absoluteString == "http://192.168.1.10:18789/focus/terminal")
    }

    @Test func `auth user script projects only the accepted legacy credential`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: " secret-token ",
            password: "fallback-password")

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: ["token": " accepted-token "])

        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        // JSONSerialization escapes forward slashes, hence the `\/` literals.
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:8443\"") == true)
        #expect(script?.contains("\"token\":\"accepted-token\"") == true)
        #expect(script?.contains("secret-token") == false)
        #expect(script?.contains("fallback-password") == false)
        #expect(script?.contains("\"gatewayUrl\":\"wss:\\/\\/gateway.example.com:8443\"") == true)
    }

    @Test func `auth user script canonicalizes an explicit default port`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:443")),
            token: "secret-token")

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(script?.contains("\"https:\\/\\/gateway.example.com\"") == true)
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:443\"") == false)
    }

    @Test func `auth user script does not project an unaccepted stored token`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: nil,
            password: nil)

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(script?.contains("stored-token") == false)
        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
    }

    @Test func `auth user script does not export stored identity grants or configured candidates`() throws {
        let gatewayID = "manual|terminal-\(UUID().uuidString)|443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)
        }
        #expect(DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "scoped-terminal-token",
            scopes: ["operator.read", "operator.write"],
            gatewayID: gatewayID).token == "scoped-terminal-token")
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: "configured-token",
            password: "configured-password",
            deviceAuthGatewayID: gatewayID)

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(script?.contains("localStorage") == false)
        #expect(script?.contains("privateKey") == false)
        #expect(script?.contains(identity.deviceId) == false)
        #expect(script?.contains("scoped-terminal-token") == false)
        #expect(script?.contains("configured-token") == false)
        #expect(script?.contains("configured-password") == false)
    }

    @Test func `auth user script omits an empty-scope stored grant and candidates`() throws {
        let gatewayID = "manual|terminal-empty-scope-\(UUID().uuidString)|443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)
        }
        #expect(DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "empty-scope-token",
            scopes: [],
            gatewayID: gatewayID).token == "empty-scope-token")
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: "configured-token",
            password: "configured-password",
            deviceAuthGatewayID: gatewayID)

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(script?.contains("empty-scope-token") == false)
        #expect(script?.contains("configured-token") == false)
        #expect(script?.contains("configured-password") == false)
    }

    @Test func `auth user script omits stored device auth and configured password`() throws {
        let gatewayID = "manual|terminal-suppressed-\(UUID().uuidString)|443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)
        }
        #expect(DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stale-terminal-token",
            gatewayID: gatewayID).token == "stale-terminal-token")
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            password: "replacement-password",
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: gatewayID)

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(script?.contains("stale-terminal-token") == false)
        #expect(script?.contains("deviceAuthSeed") == false)
        #expect(script?.contains("localStorage") == false)
        #expect(script?.contains("replacement-password") == false)
    }

    @Test func `web content identity changes with stored operator token`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        #expect(
            ControlUIHubPage.terminal.webContentIdentity(config: config, storedOperatorToken: "token-a") !=
                ControlUIHubPage.terminal.webContentIdentity(config: config, storedOperatorToken: "token-b"))
    }

    @Test func `web content identity changes with the accepted TLS pin`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let first = Self.makeConfig(
            url: url,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "first",
                allowTOFU: false,
                storeKey: "gateway"))
        let second = Self.makeConfig(
            url: url,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "second",
                allowTOFU: false,
                storeKey: "gateway"))

        #expect(
            ControlUIHubPage.terminal.webContentIdentity(config: first, storedOperatorToken: nil) !=
                ControlUIHubPage.terminal.webContentIdentity(config: second, storedOperatorToken: nil))
    }

    @Test func `authenticated Control UI origin rejects authority changes`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let defaultPortURL = try #require(URL(string: "https://GATEWAY.example.com:443/chat"))
        let alternatePortURL = try #require(URL(string: "https://gateway.example.com:8443/chat"))
        let alternateHostURL = try #require(URL(string: "https://replacement.example.com/chat"))
        let insecureURL = try #require(URL(string: "http://gateway.example.com/chat"))
        let expected = try #require(GatewayTLSAuthority(url: controlURL))

        #expect(expected == GatewayTLSAuthority(url: defaultPortURL))
        #expect(expected != GatewayTLSAuthority(url: alternatePortURL))
        #expect(expected != GatewayTLSAuthority(url: alternateHostURL))
        #expect(expected != GatewayTLSAuthority(url: insecureURL))
    }

    @Test func `authenticated Control UI canonicalizes IPv6 authorities`() throws {
        let controlURL = try #require(URL(string: "https://[2001:db8::1]:8443/control"))
        let expected = try #require(GatewayTLSAuthority(url: controlURL))

        #expect(expected.serialized == "https://[2001:db8::1]:8443")
        #expect(expected.matches(host: "2001:DB8::1", port: 8443))
        #expect(expected.matches(host: "[2001:db8::1]", port: 8443))
        #expect(!expected.matches(host: "2001:db8::2", port: 8443))
        #expect(!expected.matches(host: "2001:db8::1", port: 443))
    }

    @Test func `authenticated Control UI navigation keeps the main frame on its origin`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let sameOriginURL = try #require(URL(string: "https://gateway.example.com/chat?session=main"))
        let alternateHostURL = try #require(URL(string: "https://replacement.example.com/chat"))
        let alternatePortURL = try #require(URL(string: "https://gateway.example.com:8443/chat"))
        let embeddedURL = try #require(URL(string: "https://discussion.example.com/embed/thread/a/b"))
        let unknownFrameURL = try #require(URL(string: "https://gateway.example.com/chat"))
        let coordinator = try AuthenticatedControlUIWebViewCoordinator(
            url: controlURL,
            tls: nil)

        #expect(coordinator.navigationDecision(to: sameOriginURL, isMainFrame: true) == .allow)
        #expect(coordinator.navigationDecision(to: alternateHostURL, isMainFrame: true) == .cancel)
        #expect(coordinator.navigationDecision(to: alternatePortURL, isMainFrame: true) == .cancel)
        #expect(coordinator.navigationDecision(to: embeddedURL, isMainFrame: false) == .allow)
        #expect(coordinator.navigationDecision(to: unknownFrameURL, isMainFrame: nil) == .cancel)
    }

    @Test func `authenticated dashboard navigation cannot leave its document scope`() throws {
        let dashboardURL = try #require(URL(
            string: "https://gateway.example.com/rosita/focus/dashboard/main/nightly-cleanup"))
        let canonicalDashboardURL = try #require(URL(
            string: "https://gateway.example.com/rosita/focus/dashboard/main/nightly-cleanup-v2"))
        let dashboardRootURL = try #require(URL(
            string: "https://gateway.example.com/rosita/focus/dashboard"))
        let siblingURL = try #require(URL(
            string: "https://gateway.example.com/rosita/focus/dashboard-archive/main/nightly-cleanup"))
        let escapedScopeURL = try #require(URL(
            string: "https://gateway.example.com/rosita/focus/dashboard/%2e%2e/%2e%2e/chat"))
        let ordinaryControlUIURL = try #require(URL(
            string: "https://gateway.example.com/rosita/chat?session=agent:main:nightly-cleanup"))
        let alternateOriginURL = try #require(URL(
            string: "https://replacement.example.com/rosita/focus/dashboard/main/nightly-cleanup"))
        let embeddedURL = try #require(URL(string: "https://widgets.example.com/report"))
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: dashboardURL,
            tls: nil,
            allowedMainFramePathPrefix: "/rosita/focus/dashboard/")

        #expect(coordinator.navigationDecision(
            to: canonicalDashboardURL,
            isMainFrame: true) == .allow)
        #expect(coordinator.navigationDecision(
            to: dashboardRootURL,
            isMainFrame: true) == .allow)
        #expect(coordinator.navigationDecision(
            to: ordinaryControlUIURL,
            isMainFrame: true) == .cancelAndExitScope)
        #expect(coordinator.navigationDecision(
            to: siblingURL,
            isMainFrame: true) == .cancelAndExitScope)
        #expect(coordinator.navigationDecision(
            to: escapedScopeURL,
            isMainFrame: true) == .cancelAndExitScope)
        #expect(coordinator.navigationDecision(
            to: alternateOriginURL,
            isMainFrame: true) == .cancel)
        #expect(coordinator.navigationDecision(
            to: embeddedURL,
            isMainFrame: false) == .allow)
    }

    @Test func `authenticated Control UI TLS authority uses the normalized page authority`() throws {
        let controlURL = try #require(URL(string: "https://Gateway.Example.com/control"))
        let coordinator = try AuthenticatedControlUIWebViewCoordinator(
            url: controlURL,
            tls: nil)

        #expect(coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 0))
        #expect(coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 443))
        #expect(!coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 8443))
        #expect(!coordinator.matchesExpectedAuthority(host: "replacement.example.com", port: 443))
    }

    @Test func `auth user script opts in without projecting configured credentials`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")), token: "   ")
        let script = ControlUIHubPage.terminal.authUserScript(config: config)

        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        #expect(script?.contains("\"token\"") == false)
        #expect(
            ControlUIHubPage.terminal.authUserScript(config: nil) == nil)
    }

    @Test func `authenticated Control UI follows the resolved app appearance`() async throws {
        let cases: [(AppAppearancePreference, UIUserInterfaceStyle, UIUserInterfaceStyle)] = [
            (.dark, .light, .dark),
            (.light, .dark, .light),
            (.system, .light, .light),
            (.system, .dark, .dark),
        ]

        for (preference, systemStyle, expectedStyle) in cases {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
            window.overrideUserInterfaceStyle = systemStyle
            window.rootViewController = UIHostingController(rootView: Self.controlUIView(preference: preference))
            window.makeKeyAndVisible()
            window.rootViewController?.view.setNeedsLayout()
            window.rootViewController?.view.layoutIfNeeded()

            let webView = try await Self.webView(in: window)
            #expect(webView.overrideUserInterfaceStyle == expectedStyle)
            webView.stopLoading()
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    private static func controlUIView(preference: AppAppearancePreference) -> AnyView {
        AnyView(
            AuthenticatedControlUIWebView(
                url: URL(fileURLWithPath: "/"),
                authScript: nil,
                tls: nil)
                .preferredColorScheme(preference.colorScheme))
    }

    private static func webView(in window: UIWindow) async throws -> WKWebView {
        for _ in 0..<50 {
            if let webView = findWebView(in: window) {
                return webView
            }
            try await Task.sleep(for: .milliseconds(10))
            window.rootViewController?.view.layoutIfNeeded()
        }
        throw ControlUIAppearanceTestError.webViewNotMounted
    }

    private static func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView {
            return webView
        }
        return view.subviews.lazy.compactMap { self.findWebView(in: $0) }.first
    }
}

private enum ControlUIAppearanceTestError: Error {
    case webViewNotMounted
}
