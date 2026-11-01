import Foundation
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
            let rules = try #require(CloudflareAccessWebSession.otherPortBlockRules(
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
}
