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

    @Test func `auth user script carries credentials gated to the page origin`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: " secret-token ",
            password: "fallback-password")

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))

        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        // JSONSerialization escapes forward slashes, hence the `\/` literals.
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:8443\"") == true)
        #expect(script?.contains("\"token\":\"secret-token\"") == true)
        #expect(script?.contains("\"password\":\"fallback-password\"") == true)
        #expect(script?.contains("\"gatewayUrl\":\"wss:\\/\\/gateway.example.com:8443\"") == true)
    }

    @Test func `auth user script projects only the accepted Access credential`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: "secret-token",
            password: "fallback-password")

        let script = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: ["token": " accepted-token "])

        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        #expect(script?.contains("\"token\":\"accepted-token\"") == true)
        #expect(script?.contains("secret-token") == false)
        #expect(script?.contains("fallback-password") == false)
    }

    @Test func `Access auth user script withholds configured credentials without acceptance`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: "configured-token",
            password: "configured-password")

        let script = try #require(ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil))

        #expect(script.contains("\"nativeConnectAuth\":true"))
        #expect(!script.contains("configured-token"))
        #expect(!script.contains("configured-password"))
        #expect(!script.contains("localStorage"))
        #expect(!script.contains("privateKey"))
        #expect(!script.contains("deviceAuthSeed"))
    }

    @Test func `auth user script canonicalizes an explicit default port`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:443")),
            token: "secret-token")

        let genericScript = ControlUIHubPage.terminal.authUserScript(
            config: config,
            storedOperatorToken: nil)
        let accessScript = ControlUIHubPage.terminal.authUserScript(
            config: config,
            legacyCredentials: nil)

        #expect(genericScript?.contains("\"https:\\/\\/gateway.example.com\"") == true)
        #expect(genericScript?.contains("\"https:\\/\\/gateway.example.com:443\"") == false)
        #expect(accessScript?.contains("\"https:\\/\\/gateway.example.com\"") == true)
        #expect(accessScript?.contains("\"https:\\/\\/gateway.example.com:443\"") == false)
    }

    @Test func `auth user script selects native signing and withholds the device grant`() throws {
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
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))

        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        #expect(script?.contains("\"password\":\"configured-password\"") == true)
        #expect(script?.contains("\"token\":\"configured-token\"") == true)
        #expect(script?.contains("configured-token") == true)
        #expect(script?.contains("scoped-terminal-token") == false)
        #expect(script?.contains("privateKey") == false)
        #expect(script?.contains("openclaw-device-identity-v1") == false)
        #expect(script?.contains(identity.privateKey) == false)
    }

    @Test func `retained Access page signs only for its current operator and admission`() async throws {
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        server.acceptedOperatorScopes = ["operator.read", "operator.admin"]
        server.httpResponse = { request in
            guard request.headers["cookie"]?.contains("CF_Authorization=") == true else {
                return .init(status: 401)
            }
            if request.method == "POST", request.target == "/native-auth-effect" {
                return .init(body: Data("effect-observed".utf8))
            }
            guard request.target == "/focus/terminal" else { return .init(status: 404) }
            return .init(
                headers: ["Content-Type": "text/html"], body: Data("<!doctype html><main>Fixture</main>".utf8))
        }
        defer { server.stop() }
        let gatewayID = "native-webview-\(UUID().uuidString)"
        let tls = try GatewayTLSParams(
            required: true,
            expectedFingerprint: #require(server.fingerprint),
            allowTOFU: false,
            storeKey: nil)
        let baseApplication = try CloudflareAccessTestTokens.application()
        let application = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(server.url()),
            issuer: baseApplication.issuer,
            audience: baseApplication.audience)
        let tokens = try CloudflareAccessTestTokens()
        let sessionA = try tokens.session(subject: "retained-page-a", application: application)
        let sessionB = try tokens.session(subject: "retained-page-b", application: application)
        let admission = NativeGatewayAccessAdmissionFixture()
        let registrationID = UUID()
        func authorization(for session: CloudflareAccessSession) throws -> GatewayIngressAuthorization {
            try GatewayIngressAuthorization(
                origin: application.origin,
                principal: CloudflareAccessPrincipal.verified(from: session),
                revision: 1,
                registrationID: registrationID,
                headers: { _ in [:] },
                isCurrent: { admission.isCurrent },
                dashboardCookie: { session.dashboardCookie(for: $0) },
                checkResponse: { _ in },
                load: { request, operation in try await operation(request) })
        }
        var config = Self.makeConfig(url: server.url(), tls: tls, deviceAuthGatewayID: gatewayID)
        config.ingressAuthorization = try authorization(for: sessionA)
        var reassignedConfig = config
        reassignedConfig.ingressAuthorization = try authorization(for: sessionB)
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        model.activeGatewayConnectConfig = config
        var options = config.nodeOptions
        options.role = "operator"
        options.clientMode = "ui"
        options.scopes = ["operator.read", "operator.admin"]
        try await model.operatorSession.connect(
            url: config.url,
            credentials: .init(token: nil, bootstrapToken: nil, password: nil),
            connectOptions: options,
            sessionBox: config.webSocketSessionBox(),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in .init(id: request.id, ok: true) })
        model.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        defer {
            model.apply(.dropped, to: .operator, route: nil)
            Task { await model.operatorSession.disconnect() }
        }
        let currentRoute = await model.operatorSession.currentRoute()
        let operatorRoute = try #require(currentRoute)
        let pageURL = try #require(ControlUIHubPage.terminal.url(config: config))
        let content = try AuthenticatedControlUIWebView(
            url: pageURL,
            authScript: ControlUIHubPage.terminal.authUserScript(config: config, legacyCredentials: nil),
            tls: tls,
            nativeGatewayAuthProvider: IOSDashboardNativeGatewayAuthProvider(appModel: model, config: config),
            accessCookie: #require(sessionA.dashboardCookie(for: pageURL)),
            accessAdmissionIsCurrent: { admission.isCurrent })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: content)
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        let webView = try await Self.webView(in: window)
        defer { webView.stopLoading() }
        try await TestWait.state("native auth document committed") {
            webView.url == pageURL && !webView.isLoading
        }
        #expect(try await webView.evaluateJavaScript(
            "localStorage.getItem('openclaw-device-identity-v1') === null && localStorage.length === 0") as? Bool ==
            true)
        let challenge = """
        let reply;
        try {
          reply = await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
            id: 'fixture', nonce: 'fixture-nonce', signedAt: 1700000000000
          });
        } catch { return 'denied'; }
        if (!reply.result?.device?.signature) return 'denied';
        const response = await fetch('/native-auth-effect', { method: 'POST' });
        return response.ok ? await response.text() : 'effect-failed';
        """
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "effect-observed")
        #expect(server.requests.filter { $0.target == "/native-auth-effect" }.count == 1)

        // Keep the same page, route, admission revision and live socket. Only the current
        // Access principal changes, so a connected=false shortcut cannot explain refusal.
        model.activeGatewayConnectConfig = reassignedConfig
        #expect(model.isOperatorGatewayConnected)
        #expect(await model.operatorSession.currentOperatorScopes(ifCurrentRoute: operatorRoute) ==
            Set(["operator.read", "operator.admin"]))
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "denied")
        #expect(server.requests.filter { $0.target == "/native-auth-effect" }.count == 1)
        model.activeGatewayConnectConfig = config
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "effect-observed")
        #expect(server.requests.filter { $0.target == "/native-auth-effect" }.count == 2)
        model.apply(.dropped, to: .operator, route: nil)
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "denied")
        model.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "effect-observed")
        #expect(server.requests.filter { $0.target == "/native-auth-effect" }.count == 3)

        // This endpoint records follow-up fixture I/O, not Gateway RPC authorization.
        // Retiring A must prevent another signature and effect while its socket stays healthy.
        admission.isCurrent = false
        #expect(model.isOperatorGatewayConnected)
        #expect(await model.operatorSession.currentOperatorScopes(ifCurrentRoute: operatorRoute) ==
            Set(["operator.read", "operator.admin"]))
        #expect(try await webView.callAsyncJavaScript(
            challenge, arguments: [:], in: nil, contentWorld: .page) as? String == "denied")
        #expect(server.requests.filter { $0.target == "/native-auth-effect" }.count == 3)
        #expect(await model.operatorSession.currentRoute() == operatorRoute)
        #expect(server.roles == ["operator"])
    }

    @Test func `auth user script selects native signing for an empty-scope grant`() throws {
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
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))

        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        #expect(script?.contains("empty-scope-token") == false)
        #expect(script?.contains("\"password\":\"configured-password\"") == true)
    }

    @Test func `auth user script honors stored device auth suppression`() throws {
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
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))

        #expect(script?.contains("stale-terminal-token") == false)
        #expect(script?.contains("nativeConnectAuth") == false)
        #expect(script?.contains("\"password\":\"replacement-password\"") == true)
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

    @Test func `embedded Control UI opens documentation outside the authenticated web view`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: controlURL, tls: nil, usesNativeEmbed: true)
        for path in ["plugins/manage-plugins", "tools/skills", "tools/skill-workshop"] {
            let docsURL = try #require(URL(string: "https://docs.openclaw.ai/\(path)"))
            for target: Bool? in [nil, true] {
                #expect(coordinator.externalNavigationURL(
                    to: docsURL, sourceURL: controlURL, sourceIsMainFrame: true,
                    targetIsMainFrame: target, navigationType: .linkActivated) == docsURL)
                #expect(coordinator.navigationDecision(to: docsURL, isMainFrame: target) == .cancel)
            }
        }
    }

    @Test func `external links cannot bypass frame scheme or document scope restrictions`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let docsURL = try #require(URL(string: "https://docs.openclaw.ai/tools/skills"))
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: controlURL, tls: nil, usesNativeEmbed: true)
        let rejected: [(URL?, URL?, Bool, Bool?, WKNavigationType)] = [
            (docsURL, controlURL, true, nil, .other),
            (docsURL, controlURL, false, nil, .linkActivated),
            (docsURL, controlURL, true, false, .linkActivated),
            (docsURL, docsURL, true, nil, .linkActivated),
            (docsURL, nil, true, nil, .linkActivated),
            (nil, controlURL, true, nil, .linkActivated),
            (controlURL, controlURL, true, nil, .linkActivated),
            (URL(string: "javascript:alert(1)"), controlURL, true, nil, .linkActivated),
            (URL(string: "file:///private/example"), controlURL, true, nil, .linkActivated),
            (URL(string: "openclaw://connect"), controlURL, true, nil, .linkActivated),
            (URL(string: "https://user:password@docs.openclaw.ai/"), controlURL, true, nil, .linkActivated),
        ]
        for (destination, source, sourceMain, targetMain, type) in rejected {
            #expect(coordinator.externalNavigationURL(
                to: destination, sourceURL: source, sourceIsMainFrame: sourceMain,
                targetIsMainFrame: targetMain, navigationType: type) == nil)
        }
        for restricted in [
            AuthenticatedControlUIWebViewCoordinator(url: controlURL, tls: nil),
            AuthenticatedControlUIWebViewCoordinator(
                url: controlURL, tls: nil, allowedMainFramePathPrefix: "/control", usesNativeEmbed: true),
        ] {
            #expect(restricted.externalNavigationURL(
                to: docsURL, sourceURL: controlURL, sourceIsMainFrame: true,
                targetIsMainFrame: nil, navigationType: .linkActivated) == nil)
        }
        let localURL = URL(fileURLWithPath: "/example.html")
        let local = AuthenticatedControlUIWebViewCoordinator(url: localURL, tls: nil, usesNativeEmbed: true)
        #expect(local.externalNavigationURL(
            to: docsURL, sourceURL: localURL, sourceIsMainFrame: true,
            targetIsMainFrame: nil, navigationType: .linkActivated) == nil)
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

    @Test func `auth user script selects the matching native authentication path`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")), token: "   ")

        let genericScript = ControlUIHubPage.terminal.authUserScript(config: config, storedOperatorToken: nil)
        let accessScript = ControlUIHubPage.terminal.authUserScript(config: config, legacyCredentials: nil)

        #expect(genericScript == nil)
        #expect(accessScript?.contains("\"nativeConnectAuth\":true") == true)
        #expect(accessScript?.contains("\"token\"") == false)
        #expect(ControlUIHubPage.terminal.authUserScript(config: nil, storedOperatorToken: nil) == nil)
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

@MainActor
private final class NativeGatewayAccessAdmissionFixture {
    var isCurrent = true
}
