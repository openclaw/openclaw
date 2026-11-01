import Foundation

/// Why the embedded Dashboard fell back to the native sign-in path.
enum CloudflareAccessWebFallbackReason: Equatable, Sendable {
    /// No usable grant for this origin, or the grant was retired (sign-out, expiry, reauthentication).
    case signInRequired
    /// The edge refused a grant the app still believes is valid (for example Access binding cookies).
    case edgeRejected
}

/// Embedded Dashboard reuse of the native Access grant as a host-only browser cookie.
/// Each Dashboard WebView owns a non-persistent data store; this cookie never reaches
/// `WKWebsiteDataStore.default()`, Safari, or another Gateway's WebView.
struct CloudflareAccessWebCookie: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    static let name = "CF_Authorization"

    let origin: CloudflareAccessOrigin
    let issuerHost: String?
    let expiresAt: Date
    /// The jar's retirement generation observed before the grant was read.
    let generation: UInt64
    private let value: String

    fileprivate init(
        origin: CloudflareAccessOrigin,
        issuerHost: String?,
        expiresAt: Date,
        generation: UInt64,
        value: String)
    {
        self.origin = origin
        self.issuerHost = issuerHost
        self.expiresAt = expiresAt
        self.generation = generation
        self.value = value
    }

    /// Host-only (no Domain attribute), Secure, HttpOnly, SameSite=Lax and bounded by the grant expiry.
    ///
    /// Built from a synthetic `Set-Cookie` header because `HTTPCookie(properties:)` has no supported
    /// HttpOnly key. Fails closed unless Foundation reports every flag and the exact host back.
    func httpCookie(now: Date = Date()) -> HTTPCookie? {
        guard let host = self.origin.url.host?.lowercased(), !host.isEmpty else { return nil }
        let maxAge = Int(self.expiresAt.timeIntervalSince(now))
        guard maxAge > 0, let url = URL(string: "https://\(host)/") else { return nil }
        let header = "\(Self.name)=\(self.value); Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\(maxAge)"
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url)
        guard cookies.count == 1, let cookie = cookies.first,
              cookie.name == Self.name, cookie.value == self.value,
              cookie.domain.lowercased() == host, !cookie.domain.hasPrefix("."),
              cookie.path == "/", cookie.isSecure, cookie.isHTTPOnly,
              let expires = cookie.expiresDate,
              expires <= self.expiresAt.addingTimeInterval(1)
        else { return nil }
        return cookie
    }

    var description: String {
        "CloudflareAccessWebCookie(<redacted>)"
    }

    var debugDescription: String {
        self.description
    }

    var customMirror: Mirror {
        Mirror(self, children: [])
    }
}

enum CloudflareAccessWebSession {
    enum Decision: Equatable, Sendable {
        /// The route is not Access-managed; load as before.
        case ordinary
        /// Seed this cookie into the WebView's own store before the first load.
        case seed(CloudflareAccessWebCookie)
        /// Access-managed without a usable grant; show the native sign-in path.
        case signInRequired

        var cookie: CloudflareAccessWebCookie? {
            if case let .seed(cookie) = self { return cookie }
            return nil
        }
    }

    /// A JWT is three base64url segments. Allow-list instead of blacklisting cookie metacharacters,
    /// and stay under the size at which WebKit silently drops the cookie.
    static let maxTokenBytes = 4000

    static func isPlausibleToken(_ token: String) -> Bool {
        guard !token.isEmpty, token.utf8.count <= self.maxTokenBytes else { return false }
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return false }
        return segments.allSatisfy { segment in
            !segment.isEmpty && segment.utf8.allSatisfy { byte in
                (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
                    || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
            }
        }
    }

    /// `isCurrent` must prove the session is the exact revision the connection was admitted with.
    /// `generation` is the jar's retirement generation read BEFORE the grant, so a retirement that
    /// lands between this decision and the WebView registering is detected at registration.
    static func decision(
        ingressOrigin: CloudflareAccessOrigin?,
        pageURL: URL?,
        session: CloudflareAccessSession?,
        isCurrent: Bool,
        generation: UInt64 = 0,
        now: Date = Date()) -> Decision
    {
        guard let ingressOrigin else { return .ordinary }
        guard isCurrent, let session, session.origin == ingressOrigin,
              let pageURL, ingressOrigin.contains(pageURL),
              let token = session.authorizationHeader(for: pageURL, now: now),
              self.isPlausibleToken(token)
        else { return .signInRequired }
        return .seed(CloudflareAccessWebCookie(
            origin: ingressOrigin,
            issuerHost: session.issuer.host?.lowercased(),
            expiresAt: session.expiresAt,
            generation: generation,
            value: token))
    }

    /// A main-frame hop to the Access login means the edge rejected the seeded cookie.
    /// The edge host comes from the verified issuer, not a hard-coded suffix.
    static func isLoginNavigation(_ url: URL?, origin: CloudflareAccessOrigin, issuerHost: String?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        if let issuerHost, host == issuerHost.lowercased() { return true }
        return origin.contains(url) && url.standardized.path.hasPrefix("/cdn-cgi/access/login")
    }

    /// Cookies are not port-scoped (RFC 6265), so keep the Dashboard from talking to the Gateway host at all
    /// except through the admitted authority: block every request to the host on any port, explicit or
    /// implicit, then allow only the admitted `host[:port]`. A custom-port origin therefore also blocks the
    /// implicit default port. Returns WebKit content-rule JSON, or nil when the host is not a plain DNS name
    /// or IPv4 address. `webScheme` and `socketScheme` name the admitted transports (tests use cleartext).
    static func otherAuthorityBlockRules(for origin: CloudflareAccessOrigin) -> String? {
        self.blockRules(host: origin.url.host, port: origin.url.port, webScheme: "https", socketScheme: "wss")
    }

    static func blockRules(host: String?, port: Int?, webScheme: String, socketScheme: String) -> String? {
        guard let host = host?.lowercased(), !host.isEmpty,
              host.utf8.allSatisfy({ byte in
                  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x2E
              })
        else { return nil }
        let escaped = host.replacingOccurrences(of: ".", with: "\\.")
        var rules: [[String: Any]] = []
        func add(_ filter: String, _ action: String) {
            rules.append(["trigger": ["url-filter": filter], "action": ["type": action]])
        }
        // The authority must end at ':', a path/query/fragment delimiter, or the end of the URL, so
        // `gateway.example.test.evil.example` is not mistaken for the host.
        for scheme in ["https?", "wss?"] {
            add("^\(scheme)://\(escaped)[:/?#]", "block")
            add("^\(scheme)://\(escaped)$", "block")
        }
        let defaultPort = webScheme == "https" ? 443 : 80
        let port = port ?? defaultPort
        let authorities = port == defaultPort ? [escaped, "\(escaped):\(port)"] : ["\(escaped):\(port)"]
        for scheme in [webScheme, socketScheme] {
            for authority in authorities {
                add("^\(scheme)://\(authority)[/?#]", "ignore-previous-rules")
                add("^\(scheme)://\(authority)$", "ignore-previous-rules")
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Live seeded WebView cookie stores, so Access retirement (sign-out, forget, expiry,
/// account replacement, origin change) deletes browser copies of the grant too.
@MainActor
final class CloudflareAccessWebCookieJar {
    typealias Delete = @MainActor () async -> Void

    static let shared = CloudflareAccessWebCookieJar()

    private struct Entry {
        let origin: CloudflareAccessOrigin
        let unload: @MainActor () -> Void
        let delete: Delete
        let onRetired: @MainActor () -> Void
    }

    private var entries: [UUID: Entry] = [:]
    private var generations: [CloudflareAccessOrigin: UInt64] = [:]

    /// Bumped synchronously by every `retire`. Read it BEFORE reading the grant it guards.
    func generation(for origin: CloudflareAccessOrigin) -> UInt64 {
        self.generations[origin] ?? 0
    }

    /// Returns nil when `origin` was retired after `generation` was read: a decision made before sign-out
    /// must never register a WebView afterwards. `onRetired` runs only for Access retirement,
    /// not for an ordinary WebView teardown.
    func register(
        _ origin: CloudflareAccessOrigin,
        generation: UInt64? = nil,
        unload: @escaping @MainActor () -> Void = {},
        delete: @escaping Delete,
        onRetired: @escaping @MainActor () -> Void = {}) -> UUID?
    {
        guard (generation ?? self.generation(for: origin)) == self.generation(for: origin) else { return nil }
        let id = UUID()
        self.entries[id] = Entry(origin: origin, unload: unload, delete: delete, onRetired: onRetired)
        return id
    }

    /// False once retired; a seed that completes afterwards must not load the page.
    func isLive(_ id: UUID) -> Bool {
        self.entries[id] != nil
    }

    func liveCount(for origin: CloudflareAccessOrigin) -> Int {
        self.entries.values.count(where: { $0.origin == origin })
    }

    func release(_ id: UUID) async {
        guard let entry = self.entries.removeValue(forKey: id) else { return }
        await entry.delete()
    }

    func retire(_ origin: CloudflareAccessOrigin) async {
        // Fence and unload synchronously, before any await: later registrations are refused, and
        // existing pages stop running now rather than after cookie-store work completes.
        self.generations[origin, default: 0] += 1
        let retired = self.entries.filter { $0.value.origin == origin }
        for id in retired.keys {
            self.entries.removeValue(forKey: id)
        }
        for entry in retired.values {
            entry.unload()
            entry.onRetired()
        }
        for entry in retired.values {
            await entry.delete()
        }
    }
}
