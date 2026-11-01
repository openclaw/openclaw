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

    @Test func `the decision records the generation it was read at`() throws {
        let session = try self.session(origin: "https://gateway.example.test:8443")
        let pageURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let cookie = try #require(CloudflareAccessWebSession.decision(
            ingressOrigin: session.origin, pageURL: pageURL, session: session, isCurrent: true, generation: 7).cookie)
        #expect(cookie.generation == 7)
        #expect(cookie.issuerHost == "example.cloudflareaccess.com")
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

    @Test func `other ports on the gateway host are blocked and the admitted authority is not`() throws {
        let custom = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443")))
        let rules = try #require(CloudflareAccessWebSession.otherPortBlockRules(for: custom))
        let parsed = try #require(
            JSONSerialization.jsonObject(with: Data(rules.utf8)) as? [[String: [String: String]]])
        let filters = parsed.compactMap { $0["trigger"]?["url-filter"] }
        let actions = parsed.compactMap { $0["action"]?["type"] }
        #expect(actions == ["block", "block", "ignore-previous-rules", "ignore-previous-rules"])
        #expect(filters.first == "^https?://gateway\\.example\\.test:[0-9]+")
        #expect(filters.contains("^https://gateway\\.example\\.test:8443/"))
        // The default port has no explicit ":port" form to allow again.
        let standard = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let standardRules = try #require(CloudflareAccessWebSession.otherPortBlockRules(for: standard))
        let standardParsed = try #require(
            JSONSerialization.jsonObject(with: Data(standardRules.utf8)) as? [[String: [String: String]]])
        #expect(standardParsed.compactMap { $0["action"]?["type"] } == ["block", "block"])
        let ipv6 = try CloudflareAccessOrigin(#require(URL(string: "https://[::1]:8443")))
        #expect(CloudflareAccessWebSession.otherPortBlockRules(for: ipv6) == nil)

        func other(_ value: String) -> Bool {
            CloudflareAccessWebSession.isOtherPortOnSameHost(URL(string: value), origin: custom)
        }
        #expect(other("https://gateway.example.test:9443/x"))
        #expect(other("https://GATEWAY.example.test/x"))
        #expect(!other("https://gateway.example.test:8443/x"))
        #expect(!other("https://unrelated.example.test:9443/x"))
    }
}
