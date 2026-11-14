import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

/// These tests compile the shared openclaw.gateway-cookie-origin identifier in WKContentRuleListStore.default().
@Suite(.serialized)
@MainActor
struct DashboardEmbedCookieTests {
    private func session(
        host: String = "embed.example.com",
        issuer: String = "https://identity.example.com",
        subject: String = "fixture-account",
        type: String = "app",
        expiresAt: Date = Date().addingTimeInterval(3600)) throws -> GatewayBrowserSession
    {
        func encode(_ value: [String: Any]) throws -> String {
            try JSONSerialization.data(withJSONObject: value).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let header = try encode(["alg": "RS256"])
        let payload = try encode([
            "iss": issuer, "sub": subject, "aud": ["fixture-audience"], "type": type,
            "exp": expiresAt.timeIntervalSince1970,
        ])
        return try GatewayBrowserSession(
            origin: #require(URL(string: "https://\(host)/")),
            issuer: #require(URL(string: issuer)),
            audience: "fixture-audience",
            subject: subject,
            token: "\(header).\(payload).c3ludGhldGlj",
            expiresAt: expiresAt)
    }

    @Test func `embed installation rejects a different account and principal changes erase embeds`() async throws {
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let gateway = try self.session(host: "gateway.example.com")
        let lease = store.lease(for: gateway)
        try await lease.prepare(for: gateway.origin, in: WKUserContentController())
        let invalid = try self.session(subject: "another-account")
        await #expect(throws: GatewayBrowserSessionError.invalidSession) {
            try await lease.installEmbedSession(invalid)
        }
        try await lease.installEmbedSession(self.session())
        let next = try self.session(host: "gateway.example.com", subject: "another-account")
        try await store.lease(for: next).prepare(for: next.origin, in: WKUserContentController())
        #expect(await store.dataStore.httpCookieStore.allCookies().map(\.domain) == ["gateway.example.com"])
    }
}

extension Date {
    /// Synthetic browser sessions outlive the CI job, so a starved runner cannot expire a
    /// session in a test that is not about expiry.
    static var fixtureSessionExpiry: Date {
        Date().addingTimeInterval(24 * 60 * 60)
    }
}
