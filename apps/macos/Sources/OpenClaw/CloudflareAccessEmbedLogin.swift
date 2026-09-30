import Foundation
import OSLog

/// A profile's embedded applications share browser sign-in work, never its gateway credential.
@MainActor
final class CloudflareAccessEmbedLogin {
    typealias IsCurrent = @MainActor @Sendable () -> Bool
    typealias Discover = @MainActor @Sendable (URL) async throws -> CloudflareAccessLogin.Application?
    typealias SignIn = @MainActor @Sendable (
        CloudflareAccessLogin.Application,
        @escaping IsCurrent) async throws -> GatewayBrowserSession

    private struct ApplicationKey: Hashable {
        let principal: String
        let host: String
    }

    enum Failure: String {
        case unsupportedOrigin = "unsupported application origin"
        case notEmbedded = "application is not embedded by the dashboard"
        case retryDelayed = "automatic sign-in is cooling down"
        case noApplication = "Access application discovery failed"
        case differentIssuer = "Access application belongs to a different issuer"
        case signInFailed = "sign-in failed, expired or was cancelled"
        case documentUnavailable = "trusted dashboard iframe inspection failed"
        case cookieInstallationFailed = "cookie installation failed"
        case cookieBlocked = "WebKit did not deliver the cookie; automatic sign-in disabled for 24 hours"
    }

    private struct Installation {
        let installedAt: Date
        let expiresAt: Date
    }

    private let discover: Discover
    private let runSignIn: SignIn
    private let now: @MainActor () -> Date
    private let log: @MainActor (String, Failure) -> Void
    private var flights: [ApplicationKey: Task<GatewayBrowserSession?, Error>] = [:]
    private var retryAfter: [ApplicationKey: Date] = [:]
    private var principal: String?
    private var installations: [String: Installation] = [:]
    private var cookieBlockedUntil: [String: Date] = [:]
    private var loggedFailures: [String: Set<Failure>] = [:]

    init(
        discover: @escaping Discover = { try await CloudflareAccessLogin.discover(gatewayURL: $0) },
        signIn: @escaping SignIn = { application, isCurrent in
            try await CloudflareAccessLogin.signIn(application: application, isCurrent: { await isCurrent() })
        },
        now: @escaping @MainActor () -> Date = Date.init,
        log: @escaping @MainActor (String, Failure) -> Void = { host, failure in
            Logger(subsystem: "ai.openclaw", category: "dashboard.embed-access").warning(
                """
                Embedded Access for \(host, privacy: .private): \(failure.rawValue, privacy: .public). \
                Use the tab's sign-in link.
                """)
        })
    {
        self.discover = discover
        self.runSignIn = signIn
        self.now = now
        self.log = log
    }

    func signIn(
        appURL: URL,
        gateway: GatewayBrowserSession,
        observedIframeHosts: [String],
        isCurrent: @escaping IsCurrent) async throws -> GatewayBrowserSession?
    {
        try Task.checkCancellation()
        guard isCurrent() else { throw CancellationError() }
        try gateway.validate(for: gateway.origin, now: self.now())
        self.setPrincipal(gateway.browserDataPrincipal)
        guard appURL.scheme == "https", appURL.user == nil, appURL.password == nil,
              appURL.query == nil, appURL.fragment == nil, appURL.port == nil || appURL.port == 443,
              appURL.path.isEmpty || appURL.path == "/", let host = appURL.host?.lowercased(),
              Self.isDNSHostname(host), host != gateway.origin.host?.lowercased(),
              Self.sharesHostSuffix(host, gatewayHost: gateway.origin.host)
        else {
            self.recordFailure(appURL: appURL, reason: .unsupportedOrigin)
            return nil
        }
        guard observedIframeHosts.contains(where: { $0.lowercased() == host }) else {
            self.recordFailure(appURL: appURL, reason: .notEmbedded)
            return nil
        }
        let key = ApplicationKey(principal: gateway.browserDataPrincipal, host: host)
        if self.cookieDeliveryFailed(for: host) { return nil }
        if let flight = self.flights[key] {
            let result = try await flight.value
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            return result
        }
        if let retryAfter = self.retryAfter[key], retryAfter > self.now() {
            self.recordFailure(appURL: appURL, reason: .retryDelayed)
            return nil
        }
        let task = Task { @MainActor in
            guard isCurrent() else { throw CancellationError() }
            guard let application = try await self.discover(appURL) else {
                self.recordFailure(appURL: appURL, reason: .noApplication)
                return nil as GatewayBrowserSession?
            }
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            guard Self.sameIssuer(application.issuer, gateway.issuer) else {
                self.recordFailure(appURL: appURL, reason: .differentIssuer)
                return nil
            }
            let session = try await self.runSignIn(application, isCurrent)
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            try gateway.validate(for: gateway.origin, now: self.now())
            try session.validate(for: appURL, now: self.now())
            guard session.issuer == gateway.issuer, session.subject == gateway.subject else {
                throw CloudflareAccessLogin.LoginError.invalidSession
            }
            return session
        }
        self.flights[key] = task
        defer {
            self.flights[key] = nil
            self.retryAfter[key] = self.now().addingTimeInterval(120)
        }
        do {
            return try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch {
            self.recordFailure(appURL: appURL, reason: .signInFailed)
            throw error
        }
    }

    static func applicationURL(
        loginURL: URL,
        gateway: GatewayBrowserSession,
        now: Date = Date()) -> URL?
    {
        guard (try? gateway.validate(for: gateway.origin, now: now)) != nil,
              let parts = URLComponents(url: loginURL, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host?.lowercased() == gateway.issuer.host?.lowercased(),
              parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil, parts.fragment == nil
        else { return nil }
        let prefix = "/cdn-cgi/access/login/"
        guard parts.percentEncodedPath.hasPrefix(prefix) else { return nil }
        let host = String(parts.percentEncodedPath.dropFirst(prefix.count)).lowercased()
        guard Self.isDNSHostname(host), host != gateway.origin.host?.lowercased(),
              Self.sharesHostSuffix(host, gatewayHost: gateway.origin.host) else { return nil }
        return URL(string: "https://\(host)/")
    }

    func setPrincipal(_ principal: String?) {
        guard self.principal != principal else { return }
        self.principal = principal
        self.installations.removeAll()
        self.cookieBlockedUntil.removeAll()
        self.loggedFailures.removeAll()
    }

    func recordFailure(appURL: URL, reason: Failure) {
        guard let host = appURL.host?.lowercased(),
              self.loggedFailures[host, default: []].insert(reason).inserted else { return }
        self.log(host, reason)
    }

    func recordCookieInstallation(_ embed: GatewayBrowserSession, gateway: GatewayBrowserSession) {
        guard self.principal == gateway.browserDataPrincipal, let host = embed.origin.host?.lowercased(),
              self.cookieBlockedUntil[host] == nil else { return }
        self.installations[host] = Installation(installedAt: self.now(), expiresAt: embed.expiresAt)
    }

    private func cookieDeliveryFailed(for host: String) -> Bool {
        let now = self.now()
        if let until = self.cookieBlockedUntil[host] {
            if until > now { return true }
            self.cookieBlockedUntil[host] = nil
        }
        guard let installed = self.installations.removeValue(forKey: host) else { return false }
        let elapsed = now.timeIntervalSince(installed.installedAt)
        guard elapsed >= 0, elapsed <= 300, installed.expiresAt > now else { return false }
        self.cookieBlockedUntil[host] = now.addingTimeInterval(24 * 60 * 60)
        if self.loggedFailures[host, default: []].insert(.cookieBlocked).inserted {
            self.log(host, .cookieBlocked)
        }
        return true
    }

    private static func sharesHostSuffix(_ host: String, gatewayHost: String?) -> Bool {
        guard let gatewayHost = gatewayHost?.lowercased() else { return false }
        let suffix = host.split(separator: ".").suffix(2)
        let gatewaySuffix = gatewayHost.split(separator: ".").suffix(2)
        // Only a sanity check; subsequent cookie delivery determines WebKit's site boundary.
        return suffix.count == 2 && suffix.elementsEqual(gatewaySuffix)
    }

    private static func sameIssuer(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme == rhs.scheme && lhs.host == rhs.host && (lhs.port ?? 443) == (rhs.port ?? 443)
    }

    private static func isDNSHostname(_ host: String) -> Bool {
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard host.utf8.count <= 253, labels.count > 1,
              labels.last?.utf8.contains(where: { (65...90).contains($0) || (97...122).contains($0) }) == true
        else { return false }
        return labels.allSatisfy { label in
            let bytes = Array(label.utf8)
            let isAlphanumeric: (UInt8) -> Bool = {
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
            }
            return !bytes.isEmpty && bytes.count <= 63 && isAlphanumeric(bytes[0]) &&
                isAlphanumeric(bytes[bytes.count - 1]) && bytes.allSatisfy { isAlphanumeric($0) || $0 == 45 }
        }
    }
}
