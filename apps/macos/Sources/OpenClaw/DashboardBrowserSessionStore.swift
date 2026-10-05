import CryptoKit
import Foundation
import WebKit

/// One saved Gateway owns its WebKit state. Serializing replacement prevents an
/// old cookie write from restoring the previous account after sign-in or removal.
@MainActor
final class DashboardBrowserSessionStore {
    @MainActor
    struct Lease {
        fileprivate let owner: DashboardBrowserSessionStore
        fileprivate let revision: UInt64
        fileprivate let originalSession: GatewayBrowserSession?

        var session: GatewayBrowserSession? {
            self.isCurrent ? self.owner.session : self.originalSession
        }

        var isCurrent: Bool {
            self.owner.revision == self.revision
        }

        func signInEmbed(
            appURL: URL,
            observedIframeHosts: [String],
            documentIsCurrent: @escaping CloudflareAccessEmbedLogin.IsCurrent) async throws -> Bool
        {
            guard documentIsCurrent() else { throw CancellationError() }
            guard self.isCurrent, let gateway = self.session else { throw GatewayBrowserSessionError.superseded }
            try gateway.validate(for: gateway.origin)
            let embed = try await self.owner.embedSignIn.signIn(
                appURL: appURL, gateway: gateway, observedIframeHosts: observedIframeHosts, isCurrent: {
                    guard documentIsCurrent(), self.isCurrent, let current = self.session,
                          current.browserDataPrincipal == gateway.browserDataPrincipal
                    else { return false }
                    return (try? current.validate(for: current.origin)) != nil
                })
            guard documentIsCurrent() else { throw CancellationError() }
            guard let embed else { return false }
            do {
                try await self.owner.installEmbedSession(
                    embed, revision: self.revision, documentIsCurrent: documentIsCurrent)
            } catch {
                self.recordEmbedFailure(appURL: appURL, reason: .cookieInstallationFailed)
                throw error
            }
            return true
        }

        func recordEmbedFailure(appURL: URL, reason: CloudflareAccessEmbedLogin.Failure) {
            guard self.isCurrent else { return }
            self.owner.embedSignIn.recordFailure(appURL: appURL, reason: reason)
        }

        func installEmbedSession(_ session: GatewayBrowserSession) async throws {
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try await self.owner.installEmbedSession(session, revision: self.revision)
        }

        func prepare(for url: URL, in contentController: WKUserContentController) async throws {
            try self.session?.validate(for: url)
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try await self.owner.preparation?.value
            try Task.checkCancellation()
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try self.session?.validate(for: url)
            self.owner.prepareController(contentController)
            try await self.owner.publishCookie(revision: self.revision).value
            try Task.checkCancellation()
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try self.session?.validate(for: url)
        }
    }

    let dataStore: WKWebsiteDataStore
    private var session: GatewayBrowserSession?
    private final class Ownership {
        weak var store: DashboardBrowserSessionStore?
        var principal: String?
        var requiresRemoval = false
    }

    private static var persistentOwners: [UUID: Ownership] = [:]
    private let ownership: Ownership
    private var revision: UInt64 = 0
    private var preparation: Task<Void, Error>?
    private var cookieRule: WKContentRuleList?
    private var cookieRuleSource: String?
    private var publishedRevision: UInt64?
    private let embedSignIn: CloudflareAccessEmbedLogin
    private let preparedControllers = NSHashTable<WKUserContentController>(options: [
        .weakMemory,
        .objectPointerPersonality,
    ])

    convenience init(
        dataStore: WKWebsiteDataStore,
        embedSignIn: CloudflareAccessEmbedLogin = CloudflareAccessEmbedLogin())
    {
        self.init(dataStore: dataStore, ownership: Ownership(), embedSignIn: embedSignIn)
    }

    private init(
        dataStore: WKWebsiteDataStore,
        ownership: Ownership,
        embedSignIn: CloudflareAccessEmbedLogin = CloudflareAccessEmbedLogin())
    {
        self.dataStore = dataStore
        self.ownership = ownership
        self.embedSignIn = embedSignIn
    }

    static func persistent(
        profileID: String,
        registryNamespace: String,
        currentSession: GatewayBrowserSession? = nil) -> DashboardBrowserSessionStore
    {
        let id = self.identifier(profileID: profileID, registryNamespace: registryNamespace)
        let ownership = self.persistentOwners[id] ?? Ownership()
        // MacGatewayProfileStore clears data before publishing a changed Keychain
        // principal. That current session owns persisted data even after a cold
        // restart with no cookie; pending removals must never be overridden.
        if ownership.principal == nil, !ownership.requiresRemoval {
            ownership.principal = currentSession?.browserDataPrincipal
        }
        if let store = ownership.store { return store }
        let store = DashboardBrowserSessionStore(dataStore: WKWebsiteDataStore(forIdentifier: id), ownership: ownership)
        ownership.store = store
        self.persistentOwners[id] = ownership
        return store
    }

    static func prepareProfileChange(
        profileID: String,
        registryNamespace: String,
        previous: GatewayBrowserSession?,
        next: GatewayBrowserSession?,
        ifCurrent: @Sendable () -> Bool) async throws
    {
        guard previous != nil || next != nil else { return }
        try Task.checkCancellation()
        guard ifCurrent() else { throw GatewayBrowserSessionError.superseded }
        let store = self.persistent(profileID: profileID, registryNamespace: registryNamespace)
        let samePrincipal = previous != nil && previous?.browserDataPrincipal == next?.browserDataPrincipal
        let preparation = samePrincipal
            ? store.invalidate(previousPrincipal: previous?.browserDataPrincipal, retainingEmbedsFor: next)
            : store.removeData()
        let revision = store.revision
        try await preparation.value
        try Task.checkCancellation()
        guard ifCurrent(), store.revision == revision else { throw GatewayBrowserSessionError.superseded }
        store.ownership.principal = next?.browserDataPrincipal
    }

    static func renewProfileSession(
        profileID: String,
        registryNamespace: String,
        previous: GatewayBrowserSession,
        next: GatewayBrowserSession,
        ifCurrent: @escaping @Sendable () -> Bool) async throws
    {
        try Task.checkCancellation()
        guard ifCurrent() else { throw GatewayBrowserSessionError.superseded }
        let id = self.identifier(profileID: profileID, registryNamespace: registryNamespace)
        // With no live store, the next dashboard lease installs the saved session.
        guard let store = self.persistentOwners[id]?.store else { return }
        try await store.renewSession(previous: previous, next: next, ifCurrent: ifCurrent)
    }

    func renewSession(
        previous: GatewayBrowserSession,
        next: GatewayBrowserSession,
        ifCurrent: @escaping @Sendable () -> Bool) async throws
    {
        try Task.checkCancellation()
        guard ifCurrent(), previous.browserDataPrincipal == next.browserDataPrincipal else {
            throw GatewayBrowserSessionError.superseded
        }
        guard self.session != nil else { return }
        let revision = self.revision
        let pending = self.preparation
        let preparation = Task { @MainActor in
            // A superseded write still has to finish before its successor writes.
            _ = await pending?.result
            try Task.checkCancellation()
            guard ifCurrent(), self.revision == revision, !self.ownership.requiresRemoval,
                  self.session?.browserDataPrincipal == previous.browserDataPrincipal
            else { throw GatewayBrowserSessionError.superseded }
            guard self.cookieRule != nil else { throw GatewayBrowserSessionError.invalidSession }
            let cookie = try next.cookie()
            await self.dataStore.httpCookieStore.setCookie(cookie)
            guard ifCurrent(), self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // The account and origin did not change; retained documents and their
            // leases can use the new expiry without losing route or worker state.
            self.session = next
            self.publishedRevision = revision
            try await self.refreshCookieRule(revision: revision)
        }
        // A failed renewal must not poison later navigation with a valid session.
        self.preparation = Task { @MainActor in _ = await preparation.result }
        try await preparation.value
    }

    static func identifier(profileID: String, registryNamespace: String) -> UUID {
        // Named app profiles share a WebKit container. Match the Keychain
        // registry namespace so one process cannot replace another's cookies.
        let owner = "\(registryNamespace.utf8.count):\(registryNamespace)\(profileID)"
        let bytes = Array(SHA256.hash(data: Data("openclaw.dashboard.profile:\(owner)".utf8)).prefix(16))
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    func lease(for session: GatewayBrowserSession?) -> Lease {
        // Profile commit owns same-account cookie renewal. Opening another
        // window during that write must not retire existing document leases.
        if self.revision == 0 || self.session?.browserDataPrincipal != session?.browserDataPrincipal {
            self.replaceSession(session)
        }
        return Lease(owner: self, revision: self.revision, originalSession: session)
    }

    @discardableResult
    func invalidate(
        previousPrincipal: String? = nil,
        retainingEmbedsFor session: GatewayBrowserSession? = nil) -> Task<Void, Error>
    {
        if self.ownership.principal == nil { self.ownership.principal = previousPrincipal }
        return self.replaceSession(nil, retainingEmbedsFor: session)
    }

    func expire(_ session: GatewayBrowserSession) {
        guard self.session == session, session.expiresAt <= Date() else { return }
        self.invalidate()
    }

    @discardableResult
    func removeData() -> Task<Void, Error> {
        self.ownership.requiresRemoval = true
        return self.replaceSession(nil)
    }

    @discardableResult
    private func replaceSession(
        _ session: GatewayBrowserSession?,
        retainingEmbedsFor retainedSession: GatewayBrowserSession? = nil) -> Task<Void, Error>
    {
        let principal = session?.browserDataPrincipal
        if let previous = self.ownership.principal, let principal, previous != principal {
            self.ownership.requiresRemoval = true
        }
        self.revision &+= 1
        let revision = self.revision
        self.session = session
        self.embedSignIn.setPrincipal((session ?? retainedSession)?.browserDataPrincipal)
        self.cookieRule = nil
        self.publishedRevision = nil
        let previous = self.preparation
        let preparation = Task { @MainActor in
            // WebKit mutations cannot be cancelled once submitted. A successor
            // waits for the prior write, then clears it before publishing its cookie.
            _ = await previous?.result
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            let cookies = await self.dataStore.httpCookieStore.allCookies()
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            let current = cookies.filter { $0.name == "CF_Authorization" }
            let embedSession = session ?? retainedSession
            let samePrincipal = embedSession != nil &&
                embedSession?.browserDataPrincipal == self.ownership.principal
            let clearWebsiteData = self.ownership.requiresRemoval ||
                (session != nil && !samePrincipal)
            if clearWebsiteData {
                await self.dataStore.removeData(
                    ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            } else {
                // Credential retirement must stop old workers and cookie use,
                // while same-account renewals retain website preferences.
                await self.dataStore.removeData(
                    ofTypes: [WKWebsiteDataTypeServiceWorkerRegistrations], modifiedSince: .distantPast)
                for cookie in current {
                    if samePrincipal, let embedSession,
                       Self.embedOrigin(for: cookie, gateway: embedSession) != nil
                    { continue }
                    await self.dataStore.httpCookieStore.deleteCookie(cookie)
                }
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // A superseded task cannot consume a pending account-data removal.
            if clearWebsiteData { self.ownership.requiresRemoval = false
                self.ownership.principal = nil
            }
            if let principal { self.ownership.principal = principal }
            try await self.refreshCookieRule(revision: revision, retainingSession: retainedSession)
        }
        self.preparation = preparation
        return preparation
    }

    private func publishCookie(revision: UInt64) -> Task<Void, Error> {
        if self.publishedRevision == revision, let preparation { return preparation }
        self.publishedRevision = revision
        let previous = self.preparation
        let preparation = Task { @MainActor in
            try await previous?.value
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // Cookie matching ignores ports. Install the resource-layer policy on
            // every dashboard controller before exposing its issuer credential.
            if let cookie = try self.session?.cookie() {
                await self.dataStore.httpCookieStore.setCookie(cookie)
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
        }
        self.preparation = preparation
        return preparation
    }

    private func prepareController(_ controller: WKUserContentController) {
        guard !self.preparedControllers.contains(controller) else { return }
        if let rule = self.cookieRule { controller.add(rule) }
        self.preparedControllers.add(controller)
    }

    private func refreshCookieRule(
        revision: UInt64,
        retainingSession: GatewayBrowserSession? = nil) async throws
    {
        let rule: WKContentRuleList?
        if let session = self.session ?? retainingSession {
            let cookies = await self.dataStore.httpCookieStore.allCookies()
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            let origins = Set(cookies.compactMap { Self.embedOrigin(for: $0, gateway: session) })
            for cookie in cookies where cookie.name == "CF_Authorization" && cookie.domain != session.origin.host() {
                guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
                if Self.embedOrigin(for: cookie, gateway: session) == nil {
                    await self.dataStore.httpCookieStore.deleteCookie(cookie)
                }
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // Compilation returns an immutable snapshot; updating this cache entry
            // never changes another profile's already installed rule list.
            let source = try Self.cookieRules(for: session.origin, embedOrigins: origins)
            if source == self.cookieRuleSource, self.cookieRule != nil { return }
            rule = try await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "openclaw.gateway-cookie-origin", encodedContentRuleList: source)
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            self.cookieRuleSource = source
        } else {
            rule = nil
            self.cookieRuleSource = nil
        }
        guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
        self.cookieRule = rule
        if let rule {
            // WebKit replaces lists by identifier. Removing first would briefly
            // disable cookie blocking; no-session controllers retain their old list.
            for controller in self.preparedControllers.allObjects {
                controller.add(rule)
            }
        }
    }

    private func installEmbedSession(
        _ embed: GatewayBrowserSession,
        revision: UInt64,
        documentIsCurrent: @escaping CloudflareAccessEmbedLogin.IsCurrent = { true }) async throws
    {
        let previous = self.preparation
        let preparation = Task { @MainActor in
            try await previous?.value
            guard documentIsCurrent() else { throw CancellationError() }
            guard self.revision == revision, !self.ownership.requiresRemoval,
                  let gateway = self.session
            else { throw GatewayBrowserSessionError.superseded }
            try gateway.validate(for: gateway.origin)
            let cookie = try embed.cookie()
            guard embed.issuer == gateway.issuer, embed.subject == gateway.subject,
                  embed.origin.port == nil || embed.origin.port == 443,
                  Self.embedOrigin(for: cookie, gateway: gateway) == embed.origin
            else { throw GatewayBrowserSessionError.invalidSession }
            await self.dataStore.httpCookieStore.setCookie(cookie)
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            try await self.refreshCookieRule(revision: revision)
            self.embedSignIn.recordCookieInstallation(embed, gateway: gateway)
        }
        // Invalid embed credentials must not poison the Gateway's own lease.
        self.preparation = Task { @MainActor in _ = await preparation.result }
        try await preparation.value
    }

    static func embedOrigin(
        for cookie: HTTPCookie,
        gateway: GatewayBrowserSession,
        now: Date = Date()) -> URL?
    {
        let host = cookie.domain.lowercased()
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard cookie.name == "CF_Authorization", cookie.isSecure, cookie.isHTTPOnly,
              cookie.path == "/", cookie.expiresDate.map({ $0 > now }) ?? false,
              cookie.portList.map({ $0.allSatisfy { $0.intValue == 443 } }) ?? true,
              host != gateway.origin.host(), host.utf8.count <= 253, labels.count >= 2,
              labels.allSatisfy({ label in
                  !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" &&
                      label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
              }),
              let claims = try? CloudflareAccessLogin.decodeJWT(
                  CloudflareAccessLogin.TokenClaims.self,
                  token: cookie.value),
              claims.type == "app", claims.sub == gateway.subject,
              claims.iss == gateway.issuer.absoluteString || claims.iss + "/" == gateway.issuer.absoluteString,
              claims.exp.isFinite, claims.exp > now.timeIntervalSince1970,
              claims.nbf.map({ $0 <= now.timeIntervalSince1970 }) ?? true
        else { return nil }
        return URL(string: "https://\(host)/")
    }

    static func cookieRules(for origin: URL, embedOrigins: Set<URL> = []) throws -> String {
        guard let originHost = origin.host() else { throw GatewayBrowserSessionError.invalidSession }
        let host = NSRegularExpression.escapedPattern(for: originHost)
        let port = origin.port.map { ":\($0)" } ?? "(:443)?"
        var patterns = ["https", "wss"].map { "^\($0)://\(host)\(port)/" }
        for origin in embedOrigins.sorted(by: { $0.absoluteString < $1.absoluteString }) {
            guard origin.scheme == "https", let host = origin.host(), origin.port == nil || origin.port == 443,
                  origin.user == nil, origin.password == nil
            else { throw GatewayBrowserSessionError.invalidSession }
            patterns.append("^https://\(NSRegularExpression.escapedPattern(for: host))(:443)?/")
        }
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block-cookies"]],
        ] + patterns.map { pattern in
            ["trigger": ["url-filter": pattern], "action": ["type": "ignore-previous-rules"]]
        }
        guard let encoded = try String(data: JSONSerialization.data(withJSONObject: rules), encoding: .utf8)
        else { throw GatewayBrowserSessionError.invalidSession }
        return encoded
    }
}
