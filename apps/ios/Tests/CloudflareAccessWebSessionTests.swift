import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct CloudflareAccessWebSessionTests {
    private final class Events {
        var values: [String] = []
        var stored: [CloudflareAccessOrigin: String] = [:]
    }

    private func session(
        origin: String,
        subject: String = "test-subject",
        token: String = "header.payload.signature",
        expires: Date = Date().addingTimeInterval(3600)) throws -> CloudflareAccessSession
    {
        let application = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: origin))),
            issuer: #require(URL(string: "https://example.cloudflareaccess.com")),
            audience: "test-audience")
        return CloudflareAccessSession(application: application, subject: subject, token: token, expiresAt: expires)
    }

    @Test func `cookie is host only secure and bounded by the grant for its exact origin`() throws {
        let session = try self.session(origin: "https://gateway.example.test:8443")
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let decision = CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true)
        let cookie = try #require(decision.cookie)
        #expect(cookie.origin == session.origin)
        #expect(cookie.expiresAt == session.expiresAt)
        #expect(!String(describing: cookie).contains("payload"))
        let http = try #require(cookie.httpCookie())
        #expect(http.name == "CF_Authorization")
        #expect(http.value == "header.payload.signature")
        #expect(http.domain == "gateway.example.test")
        #expect(!http.domain.hasPrefix("."))
        #expect(http.path == "/")
        #expect(http.isSecure)
        #expect(http.isHTTPOnly)
        #expect(!http.isSessionOnly)
        // Max-Age is relative to when the header was parsed, so allow a small skew.
        let expires = try #require(http.expiresDate)
        #expect(abs(expires.timeIntervalSince(session.expiresAt)) < 2)
        #expect(String(reflecting: cookie) == "CloudflareAccessWebCookie(<redacted>)")
        #expect(Mirror(reflecting: cookie).children.isEmpty)
    }

    @Test func `no cookie for a page or session on a different origin`() throws {
        let session = try self.session(origin: "https://gateway.example.test:8443")
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        for value in [
            "https://other.example.test/settings", "https://gateway.example.test/settings",
            "http://gateway.example.test:8443/settings", "https://user@gateway.example.test:8443/",
        ] {
            let pageURL = try #require(URL(string: value))
            #expect(CloudflareAccessWebSession.decision(
                ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true)
                == .signInRequired)
        }
        let otherPage = try #require(URL(string: "https://other.example.test/settings"))
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: other, pageURL: otherPage, session: session, isCurrent: true) == .signInRequired)
    }

    @Test func `expired stale or missing snapshot yields the sign in fallback`() throws {
        let session = try self.session(origin: "https://gateway.example.test:8443")
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin,
            pageURL: pageURL,
            session: session,
            isCurrent: true,
            now: session.expiresAt) == .signInRequired)
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: false) == .signInRequired)
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: nil, isCurrent: true) == .signInRequired)
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: nil, pageURL: pageURL, session: nil, isCurrent: false) == .ordinary)
    }

    @Test func `tokens that could inject cookie attributes are refused`() throws {
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        for token in ["a.b.c; Domain=example.test", "a.b.c,d", "a b", "\"a.b.c\""] {
            let session = try self.session(origin: "https://gateway.example.test:8443", token: token)
            #expect(CloudflareAccessWebSession.decision(
                ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true)
                == .signInRequired)
        }
    }

    @Test func `Access login navigations are recognized only for the edge or this origin`() throws {
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443")))
        for value in [
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/gateway.example.test",
            "https://gateway.example.test:8443/cdn-cgi/access/login/gateway.example.test?kid=x",
        ] {
            #expect(CloudflareAccessWebSession.isLoginNavigation(
                URL(string: value), origin: origin, issuerHost: "team.cloudflareaccess.com"))
        }
        for value in [
            "https://gateway.example.test:8443/settings", "https://other.example.test/cdn-cgi/access/login",
            "http://team.cloudflareaccess.com/", "https://cloudflareaccess.com.evil.test/",
            "https://other-team.cloudflareaccess.com/cdn-cgi/access/login",
        ] {
            #expect(!CloudflareAccessWebSession.isLoginNavigation(
                URL(string: value), origin: origin, issuerHost: "team.cloudflareaccess.com"))
        }
    }

    @Test func `sign out retires only that origin's seeded stores and blocks late seeds`() async throws {
        let jar = CloudflareAccessWebCookieJar()
        let first = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443")))
        let second = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let events = Events()
        let registeredA = jar.register(
            first,
            unload: { events.values.append("unload-a") },
            delete: { events.values.append("delete-a") },
            onRetired: { events.values.append("retired-a") })
        let registeredB = jar.register(
            second, delete: { events.values.append("delete-b") }, onRetired: { events.values.append("retired-b") })
        let a = try #require(registeredA)
        let b = try #require(registeredB)
        await jar.retire(first)
        // Pages stop and the fallback is requested before any cookie-store work.
        #expect(events.values == ["unload-a", "retired-a", "delete-a"])
        #expect(!jar.isLive(a))
        #expect(jar.isLive(b))
        #expect(jar.liveCount(for: first) == 0)
        #expect(jar.liveCount(for: second) == 1)
        // Ordinary teardown deletes the copy without asking the user to sign in again.
        await jar.release(b)
        #expect(events.values == ["unload-a", "retired-a", "delete-a", "delete-b"])
        await jar.release(a)
        #expect(events.values.count == 4)
    }

    @Test func `store forget drives web cookie retirement and the snapshot falls back`() async throws {
        let jar = CloudflareAccessWebCookieJar()
        let session = try CloudflareAccessTestTokens().session()
        let encoded = try #require(String(data: JSONEncoder().encode(session), encoding: .utf8))
        let memory = Events()
        memory.stored[session.origin] = encoded
        let store = CloudflareAccessSessionStore(
            persistence: .init(
                load: { memory.stored[$0] },
                save: { memory.stored[$0] = $1
                    return true
                },
                delete: { memory.stored.removeValue(forKey: $0)
                    return true
                }),
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed },
            retireTransports: { await jar.retire($0) })
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let snapshot = try #require(store.snapshot(for: session.origin))
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: snapshot.session, isCurrent: true).cookie != nil)
        let events = Events()
        let registered = jar.register(session.origin, delete: { events.values.append("delete") })
        let id = try #require(registered)
        try await store.forget(session.origin).task.value
        #expect(events.values == ["delete"])
        #expect(memory.stored[session.origin] == nil)
        #expect(!jar.isLive(id))
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin,
            pageURL: pageURL,
            session: store.snapshot(for: session.origin)?.session,
            isCurrent: true) == .signInRequired)
    }

    @Test func `gateways on different origins get isolated cookies and grants`() throws {
        let first = try self.session(origin: "https://gateway.example.test:8443", token: "first.token.sig")
        let second = try self.session(origin: "https://other.example.test", token: "second.token.sig")
        let firstPage = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let secondPage = try #require(URL(string: "https://other.example.test/settings"))
        let firstCookie = try #require(CloudflareAccessWebSession.decision(
            ingressOrigin: first.origin, pageURL: firstPage, session: first, isCurrent: true).cookie?.httpCookie())
        let secondCookie = try #require(CloudflareAccessWebSession.decision(
            ingressOrigin: second.origin, pageURL: secondPage, session: second, isCurrent: true).cookie?.httpCookie())
        #expect(firstCookie.domain == "gateway.example.test")
        #expect(firstCookie.value == "first.token.sig")
        #expect(secondCookie.domain == "other.example.test")
        #expect(secondCookie.value == "second.token.sig")
        // A grant never crosses to the other gateway, in either direction.
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: second.origin, pageURL: secondPage, session: first, isCurrent: true) == .signInRequired)
        #expect(CloudflareAccessWebSession.decision(
            ingressOrigin: first.origin, pageURL: firstPage, session: second, isCurrent: true) == .signInRequired)
    }

    @Test func `a decision made before sign out cannot register a WebView afterwards`() async throws {
        let jar = CloudflareAccessWebCookieJar()
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443")))
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let observed = jar.generation(for: origin)
        let otherObserved = jar.generation(for: other)
        // Sign-out lands after the decision but before the WebView exists: nothing is registered yet.
        await jar.retire(origin)
        #expect(jar.generation(for: origin) == observed + 1)
        #expect(jar.register(origin, generation: observed, delete: {}) == nil)
        #expect(jar.liveCount(for: origin) == 0)
        // Retiring one origin never fences another.
        #expect(jar.generation(for: other) == otherObserved)
        #expect(jar.register(other, generation: otherObserved, delete: {}) != nil)
        // A decision read after the retirement registers normally.
        #expect(jar.register(origin, generation: jar.generation(for: origin), delete: {}) != nil)
    }

    @Test func `only well formed base64url JWT tokens are seeded`() {
        for token in ["aaa.bbb.ccc", "a-b_c.D1.e2"] {
            #expect(CloudflareAccessWebSession.isPlausibleToken(token))
        }
        let tooLong = String(repeating: "a", count: CloudflareAccessWebSession.maxTokenBytes)
        for token in [
            "", "a.b", "a.b.c.d", "a..c", ".b.c", "a.b.c=", "a.b.c\u{7}", "a.b.cé", "a b.c.d", "a.b.c/",
            "\(tooLong).b.c",
        ] {
            #expect(!CloudflareAccessWebSession.isPlausibleToken(token))
        }
    }

    @Test func `cookie construction fails closed once the grant has expired`() throws {
        let session = try self.session(origin: "https://gateway.example.test:8443")
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let cookie = try #require(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true).cookie)
        #expect(cookie.httpCookie(now: session.expiresAt) == nil)
        #expect(cookie.httpCookie(now: session.expiresAt.addingTimeInterval(60)) == nil)
    }

    /// Evaluates content rules in order the way WebKit does: `block` blocks, `ignore-previous-rules` re-allows.
    private func isBlocked(_ url: String, by rules: String) throws -> Bool {
        let parsed = try #require(JSONSerialization.jsonObject(with: Data(rules.utf8)) as? [[String: [String: String]]])
        var blocked = false
        for rule in parsed {
            let filter = try #require(rule["trigger"]?["url-filter"])
            let regex = try NSRegularExpression(pattern: filter, options: [.caseInsensitive])
            guard regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil else { continue }
            blocked = rule["action"]?["type"] == "block"
        }
        return blocked
    }

    @Test func `requests to the gateway host are blocked except the admitted authority`() throws {
        let custom = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443")))
        let customRules = try #require(CloudflareAccessWebSession.otherAuthorityBlockRules(for: custom))
        for url in [
            "https://gateway.example.test:8443/", "https://gateway.example.test:8443/app?x=1",
            "https://gateway.example.test:8443", "https://gateway.example.test:8443#top",
            "wss://gateway.example.test:8443/socket",
            // Different sites that merely share a prefix or suffix are not the Gateway host.
            "https://gateway.example.test.evil.example/x", "https://other.example.test/x",
            "https://cdn.example.net:8443/x",
        ] {
            #expect(try !self.isBlocked(url, by: customRules), "\(url) should be allowed")
        }
        for url in [
            // Implicit and explicit default port: the cookie is not port-scoped, so these must not load.
            "https://gateway.example.test/pixel", "https://gateway.example.test", "https://gateway.example.test?x=1",
            "https://gateway.example.test:443/pixel", "https://GATEWAY.example.test/pixel",
            "https://gateway.example.test:9443/x", "https://gateway.example.test:84430/x",
            "http://gateway.example.test:8443/x", "ws://gateway.example.test:8443/x",
            "wss://gateway.example.test/socket", "wss://gateway.example.test:9443/socket",
        ] {
            #expect(try self.isBlocked(url, by: customRules), "\(url) should be blocked")
        }

        let standard = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let standardRules = try #require(CloudflareAccessWebSession.otherAuthorityBlockRules(for: standard))
        for url in [
            "https://gateway.example.test/x", "https://gateway.example.test", "https://gateway.example.test:443/x",
            "wss://gateway.example.test/socket", "https://other.example.test/x",
        ] {
            #expect(try !self.isBlocked(url, by: standardRules), "\(url) should be allowed")
        }
        for url in [
            "https://gateway.example.test:8443/x", "http://gateway.example.test/x", "ws://gateway.example.test/socket",
        ] {
            #expect(try self.isBlocked(url, by: standardRules), "\(url) should be blocked")
        }

        let ipv6 = try CloudflareAccessOrigin(#require(URL(string: "https://[::1]:8443")))
        #expect(CloudflareAccessWebSession.otherAuthorityBlockRules(for: ipv6) == nil)
    }
}
