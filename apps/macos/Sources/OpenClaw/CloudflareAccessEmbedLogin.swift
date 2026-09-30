import Foundation

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

    private let discover: Discover
    private let runSignIn: SignIn
    private let now: @MainActor () -> Date
    private var flights: [ApplicationKey: Task<GatewayBrowserSession?, Error>] = [:]
    private var retryAfter: [ApplicationKey: Date] = [:]

    init(
        discover: @escaping Discover = { try await CloudflareAccessLogin.discover(gatewayURL: $0) },
        signIn: @escaping SignIn = { application, isCurrent in
            try await CloudflareAccessLogin.signIn(application: application, isCurrent: { await isCurrent() })
        },
        now: @escaping @MainActor () -> Date = Date.init)
    {
        self.discover = discover
        self.runSignIn = signIn
        self.now = now
    }

    func signIn(
        appURL: URL,
        gateway: GatewayBrowserSession,
        isCurrent: @escaping IsCurrent) async throws -> GatewayBrowserSession?
    {
        try Task.checkCancellation()
        guard isCurrent() else { throw CancellationError() }
        try gateway.validate(for: gateway.origin, now: self.now())
        guard appURL.scheme == "https", appURL.user == nil, appURL.password == nil,
              appURL.query == nil, appURL.fragment == nil, appURL.port == nil || appURL.port == 443,
              appURL.path.isEmpty || appURL.path == "/", let host = appURL.host?.lowercased(),
              Self.isDNSHostname(host), host != gateway.origin.host?.lowercased()
        else { return nil }
        let key = ApplicationKey(principal: gateway.browserDataPrincipal, host: host)
        if let flight = self.flights[key] {
            let result = try await flight.value
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            return result
        }
        if let retryAfter = self.retryAfter[key], retryAfter > self.now() {
            return nil
        }
        let task = Task { @MainActor in
            guard isCurrent() else { throw CancellationError() }
            guard let application = try await self.discover(appURL) else { return nil as GatewayBrowserSession? }
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            guard Self.sameIssuer(application.issuer, gateway.issuer) else { return nil }
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
        defer { self.flights[key] = nil }
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            self.retryAfter[key] = result == nil ? self.now().addingTimeInterval(120) : nil
            return result
        } catch {
            self.retryAfter[key] = self.now().addingTimeInterval(120)
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
        guard Self.isDNSHostname(host), host != gateway.origin.host?.lowercased() else { return nil }
        return URL(string: "https://\(host)/")
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
