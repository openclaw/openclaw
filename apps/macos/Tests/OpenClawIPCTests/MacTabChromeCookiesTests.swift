import AppKit
import Foundation
import SQLite3
import Testing
import WebKit
@testable import OpenClaw

struct MacTabChromeCookiesTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func cookie(
        domain: String = ".example.test", expires: Date? = nil,
        secure: Bool = true, sameSite: Int = 2) -> MacTabChromeCookies.Cookie
    {
        .init(domain: domain, name: "synthetic-session", value: "synthetic-cookie-value", path: "/",
              expires: expires, secure: secure, httpOnly: true, sameSite: sameSite)
    }

    @Test func `cookie security and lifetime survive the Foundation conversion`() throws {
        let session = try #require(Self.cookie().httpCookie(protectedHost: "gateway.invalid", now: Self.now))
        #expect(session.isSecure)
        #expect(session.isHTTPOnly)
        #expect(session.isSessionOnly)
        #expect(session.domain == ".example.test")
        #expect(session.sameSitePolicy == .sameSiteStrict)
        let expiry = Self.now.addingTimeInterval(3600)
        let persistent = try #require(Self.cookie(domain: "example.test", expires: expiry, sameSite: 1)
            .httpCookie(protectedHost: nil, now: Self.now))
        #expect(!persistent.isSessionOnly)
        #expect(persistent.expiresDate == expiry)
        #expect(persistent.domain == "example.test")
        #expect(persistent.sameSitePolicy == .sameSiteLax)
        let crossSite = try #require(Self.cookie(sameSite: 0).httpCookie(protectedHost: nil, now: Self.now))
        #expect(crossSite.sameSitePolicy?.rawValue == "none")
    }

    @Test func `expired insecure None and Gateway-scoped cookies are not imported`() {
        #expect(Self.cookie(expires: Self.now).httpCookie(protectedHost: nil, now: Self.now) == nil)
        #expect(Self.cookie(secure: false, sameSite: 0).httpCookie(protectedHost: nil, now: Self.now) == nil)
        #expect(Self.cookie().httpCookie(protectedHost: "gateway.example.test", now: Self.now) == nil)
        #expect(Self.cookie(domain: "gateway.example.test")
            .httpCookie(protectedHost: "gateway.example.test", now: Self.now) == nil)
        #expect(Self.cookie(domain: "example.test")
            .httpCookie(protectedHost: "gateway.example.test", now: Self.now) != nil)
        #expect(Self.cookie().httpCookie(protectedHost: "notexample.test", now: Self.now) != nil)
        #expect(Self.cookie(sameSite: -1).httpCookie(protectedHost: nil, now: Self.now)?.sameSitePolicy == .sameSiteLax)
    }

    @Test func `synthetic Chrome ciphertext is bound to the schema 24 host`() throws {
        // Synthetic AES fixtures: a repeated test key, never a real Keychain secret.
        let key = Data(repeating: 0x61, count: 16)
        let old = try #require(Data(base64Encoded: "djEwDKi6TEAGWe1pUirmJ0whVyA35fuJS0oxDsJyrckpXyU="))
        let current = try #require(Data(base64Encoded:
            "djEwnoMic2YMIvru4HoIyLGZVIQ8FSSXY5kNKcK5OiXOCeJtGWci9sgemv8WtkPwH/YlMSI4Vg9CdhTVPJ7KjgDtkw=="))
        #expect(try MacTabChromeCookies.decrypt(
            old, key: key, domain: ".example.test", version: 23) == "synthetic-session")
        #expect(try MacTabChromeCookies.decrypt(
            current, key: key, domain: ".example.test", version: 24) == "synthetic-session")
        #expect(throws: MacTabChromeCookies.ImportError.self) {
            try MacTabChromeCookies.decrypt(current, key: key, domain: "other.test", version: 24)
        }
        #expect(throws: MacTabChromeCookies.ImportError.self) {
            try MacTabChromeCookies.decrypt(old, key: key, domain: ".example.test", version: 24)
        }
    }

    @Test func `read-only Chrome import skips partitions and unsupported encryption without Keychain access`() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile = root.appendingPathComponent("Default")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = profile.appendingPathComponent("Cookies")
        var database: OpaquePointer?
        try #require(sqlite3_open(path.path, &database) == SQLITE_OK)
        let handle = try #require(database)
        defer { sqlite3_close(handle) }
        let sql = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE meta(key TEXT, value TEXT);
        INSERT INTO meta VALUES('version', '24');
        CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
                             expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER,
                             samesite INTEGER, top_frame_site_key TEXT);
        INSERT INTO cookies VALUES('.example.test','synthetic','synthetic-value',X'','/',0,1,1,0,2,'');
        INSERT INTO cookies VALUES('.example.test','partitioned','synthetic',X'','/',0,1,1,0,2,'https://other.test');
        INSERT INTO cookies VALUES('.example.test','unsupported','',X'763230','/',0,1,1,0,2,'');
        """
        try #require(sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK)
        let profiles = MacTabChromeCookies.profiles(root: root)
        let selected = try #require(profiles.first)
        let batch = try MacTabChromeCookies.read(selected, root: root)
        #expect(batch.total == 3)
        #expect(batch.skipped == 2)
        #expect(batch.failed == 0)
        #expect(batch.cookies.count == 1)
        #expect(batch.cookies.first?.value == "synthetic-value")
    }
}

@Suite(.serialized)
@MainActor
struct MacTabCookieStoreTests {
    @Test func `import targets the existing and future Mac tab store not the dashboard`() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let dashboard = WKWebView(frame: .zero, configuration: configuration)
        let container = NSView()
        let store = WKWebsiteDataStore.nonPersistent()
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard, container: container, websiteDataStore: store, onStateChange: { _ in })
        defer { host.dispose() }
        let url = try #require(URL(string: "about:blank"))
        try host.open(tabId: "before", url: url, sessionKey: nil)
        let batch = MacTabChromeCookies.Batch(cookies: [MacTabChromeCookiesTests.cookie()], total: 1)
        let result = try await host.importChromeCookies(batch, protectedHost: "gateway.invalid", isCurrent: { true })
        #expect(result.imported == 1)
        #expect(!result.persistent)
        try host.open(tabId: "after", url: url, sessionKey: nil)
        for id in ["before", "after"] {
            let webView = try #require(host.webView(for: id))
            #expect(webView.configuration.websiteDataStore === store)
            let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
            #expect(cookies.contains { $0.name == "synthetic-session" && $0.isHTTPOnly && $0.isSecure })
        }
        let dashboardCookies = await dashboard.configuration.websiteDataStore.httpCookieStore.allCookies()
        #expect(!dashboardCookies.contains { $0.name == "synthetic-session" })
    }

    @Test func `retired document cannot write cookies`() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let dashboard = WKWebView(frame: .zero, configuration: configuration)
        let container = NSView()
        let store = WKWebsiteDataStore.nonPersistent()
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard, container: container, websiteDataStore: store, onStateChange: { _ in })
        defer { host.dispose() }
        do {
            _ = try await host.importChromeCookies(
                .init(cookies: [MacTabChromeCookiesTests.cookie()], total: 1),
                protectedHost: nil, isCurrent: { false })
            Issue.record("Retired import must fail")
        } catch is CancellationError {}
        #expect(await store.httpCookieStore.allCookies().isEmpty)
    }
}
