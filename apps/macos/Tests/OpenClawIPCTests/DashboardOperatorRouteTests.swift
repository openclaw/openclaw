import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct DashboardOperatorRouteTests {
    @Test func `ready notifications prepare the operator cookie before returning a dashboard route`() async throws {
        let defaultsName = "DashboardOperatorRouteTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let regularStore = WKWebsiteDataStore.nonPersistent()
        let manager = DashboardManager._testMake(
            websiteDataStore: regularStore,
            selection: MacGatewaySelectionPreferences(defaults: defaults),
            browserIdentityURLProvider: { _, _ in
                Issue.record("An operator route must not discover browser sign-in")
                return nil
            },
            controlUiBasePathProvider: { _, _ in "/control/" })
        let gatewayURL = try #require(URL(string: "wss://claw.example/"))
        // Endpoint ready notifications carry no native session, unlike an explicit Reload.
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (gatewayURL, nil, nil), routeAuthority: nil, revision: 2)
        for port in [52811, 52812] {
            let proxyURL = try #require(URL(string: "http://127.0.0.1:\(port)/"))
            let cookie = try #require(HTTPCookie(properties: [
                .name: MacOpenClawIDDashboardProxy.cookieName,
                .value: "synthetic-\(port)",
                .domain: "127.0.0.1",
                .path: "/",
                .init("HttpOnly"): "TRUE",
                .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict,
            ]))
            let configuration = try await manager.dashboardConfiguration(
                endpoint: endpoint,
                mode: .remote,
                target: .primary,
                token: nil,
                operatorDashboardProvider: { url in
                    #expect(url == gatewayURL)
                    return (proxyURL, cookie)
                }).configuration
            let store = try #require(configuration.operatorDataStore)
            #expect(store !== regularStore)
            #expect(!store.isPersistent)
            #expect(configuration.operatorCookieRule != nil)
            #expect(configuration.url.absoluteString == "http://127.0.0.1:\(port)/control/")
            #expect(configuration.auth.gatewayUrl == "ws://127.0.0.1:\(port)/")
            #expect(configuration.auth.token == nil)
            let cookies = await store.httpCookieStore.allCookies()
            #expect(cookies.filter { $0.name == cookie.name }.map(\.value) == [cookie.value])
            #expect(await regularStore.httpCookieStore.allCookies().isEmpty)
        }
    }
}
