import ConcurrencyExtras
import CryptoKit
import Foundation
import OpenClawKit
import OSLog
import Security

struct MacGatewayProfile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var url: URL
}

enum MacGatewayProfileError: LocalizedError, Equatable {
    case invalidURL
    case insecureRemoteURL
    case profileNotFound
    case unsupportedRegistryVersion(Int)
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Enter a Gateway hostname or an HTTPS, ws://, or wss:// URL."
        case .insecureRemoteURL:
            "Public Gateway hosts require wss://. Use ws:// only on loopback, a trusted private network, or Tailnet."
        case .profileNotFound:
            "That Gateway profile no longer exists."
        case let .unsupportedRegistryVersion(version):
            "Gateway profiles were written by a newer OpenClaw version (schema \(version))."
        case let .keychain(status):
            if !AppLaunchRuntimePlan.current.allowsActivation {
                "Could not access Gateway settings in Keychain (\(status)). " +
                    "Authorization dialogs are disabled by --no-activate; relaunch without the flag and retry."
            } else {
                "Could not save Gateway settings in Keychain (\(status))."
            }
        }
    }
}

/// Persistent gateway identities and credentials for independently routed windows.
/// Profiles are Keychain-backed so endpoint ownership and its secrets commit together.
actor MacGatewayProfileStore {
    static let shared = MacGatewayProfileStore()
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.browser-sign-in")

    static let willChangePrincipalNotification = Notification.Name("openclaw.gateway-profiles.will-change-principal")
    static let didChangeNotification = Notification.Name("openclaw.gateway-profiles.did-change")
    static let changedProfileIDKey = "profileID"
    static let removedProfileKey = "removed"
    static let changeIDKey = "changeID"
    static let renewedBrowserSessionKey = "renewedBrowserSession"

    struct StoredProfile: Codable, Equatable {
        var profile: MacGatewayProfile
        var credentials: Credentials
    }

    struct Registry: Codable, Equatable {
        var version = 1
        var legacyPrimaryMigrationVersion: Int?
        var profiles: [StoredProfile] = []
    }

    struct Credentials: Codable, Equatable {
        var token: String?
        var password: String?
        var browserSession: GatewayBrowserSession?
    }

    struct BrowserSignInAttempt: Equatable, Sendable {
        let id: UUID
        let profileID: String
        let url: URL
        fileprivate let liveness = LockIsolated(true)

        var isCurrent: Bool {
            self.liveness.value
        }

        func revoke() {
            self.liveness.withValue { $0 = false }
        }

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.id == rhs.id
        }
    }

    // Dev builds carry a different code signature; creating the release item
    // would poison its Keychain ACL and make the shipped app demand the login
    // keychain password on every read. DEBUG is a config heuristic, not a
    // signing check: it covers swift build/Xcode dev runs, the observed
    // poisoning path. Release-config ad-hoc builds stay out of scope; running
    // those against saved Keychain items is already unsupported.
    #if DEBUG
    private static let baseService = "ai.openclaw.gateway-profiles.debug"
    #else
    private static let baseService = "ai.openclaw.gateway-profiles"
    #endif
    static var service: String {
        AppProfile.current.keychainService(base: self.baseService)
    }

    private static let registryAccount = "registry-v1"
    private static let currentLegacyPrimaryMigrationVersion = 1

    /// Registry reads are prompt-bearing: when this binary is missing from the
    /// item's ACL, every SecItemCopyMatching raises a login-keychain dialog, and
    /// catalog refreshes fire per control-channel state change. Cache the one
    /// registry for the process lifetime; saves keep it coherent.
    private var cachedRegistry: Registry?
    private var keychainAccess = GatewayKeychainAccess()
    private var browserSignInAttempts: [String: BrowserSignInAttempt] = [:]
    private var browserRenewalSchedule = BrowserRenewalSchedule()

    struct BrowserRenewalSchedule {
        private var lastAttempts: [String: (credential: String, at: Date)] = [:]

        mutating func admit(
            profileID: String,
            session: GatewayBrowserSession?,
            now: Date,
            userPresent: Bool,
            inUse: Bool,
            alreadySigningIn: Bool) -> Bool
        {
            guard userPresent, inUse, !alreadySigningIn, let session,
                  session.expiresAt > now,
                  session.expiresAt.timeIntervalSince(now) <= session.renewalLeadTime,
                  // Each renewed token starts fresh; one token retries after half its window.
                  self.lastAttempts[profileID].map({
                      $0.credential != session.credentialFingerprint ||
                          now.timeIntervalSince($0.at) >= min(24 * 60 * 60, session.renewalLeadTime / 2)
                  }) ?? true
            else { return false }
            self.lastAttempts[profileID] = (session.credentialFingerprint, now)
            return true
        }
    }

    private struct CommitState {
        let removesProfile: Bool
        var identityWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    }

    private var committingBrowserSignIns: [UUID: CommitState] = [:]
    private var credentialTransitions: [String: Bool] = [:]

    static func migratingLegacyPrimaryConnection(
        root: [String: Any],
        registry: Registry) -> Registry
    {
        guard (registry.legacyPrimaryMigrationVersion ?? 0) < self.currentLegacyPrimaryMigrationVersion else {
            return registry
        }
        var migrated = registry
        migrated.legacyPrimaryMigrationVersion = self.currentLegacyPrimaryMigrationVersion

        let mode = ConnectionModeResolver.resolve(root: root)
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        guard mode.mode == .remote,
              mode.source == .configMode || mode.source == .configRemoteURL,
              resolution.transport == .direct,
              let directURL = resolution.directURL,
              let profile = try? self.makeProfile(name: "", url: directURL),
              !migrated.profiles.contains(where: { $0.profile.id == profile.id })
        else {
            return migrated
        }

        migrated.profiles.append(StoredProfile(
            profile: profile,
            credentials: Credentials(
                token: GatewayRemoteConfig.resolveTokenString(root: root),
                password: GatewayRemoteConfig.resolvePasswordString(root: root))))
        return migrated
    }

    func beginBrowserSignIn(url: URL) throws -> BrowserSignInAttempt {
        // Cancelled callers must not migrate state or revoke another sign-in.
        try Task.checkCancellation()
        let url = try Self.canonicalURL(url)
        self.keychainAccess.allowRetry()
        // Finish legacy import before capturing ownership; a late callback may
        // replace only this attempt, never a subsequently edited or forgotten profile.
        _ = try self.loadRegistryMigratingLegacyPrimary()
        return self.makeBrowserSignInAttempt(url: url)
    }

    func beginAutomaticBrowserRenewal(
        profileID: String, now: Date, userPresent: Bool, inUse: Bool) -> (MacGatewayProfile, BrowserSignInAttempt)?
    {
        // Automatic work only consumes an already loaded registry, never retries a
        // denied Keychain read or imports profiles merely because a timer fired.
        guard !Task.isCancelled,
              let stored = self.cachedRegistry?.profiles.first(where: { $0.profile.id == profileID }),
              self.browserRenewalSchedule.admit(
                  profileID: profileID,
                  session: stored.credentials.browserSession,
                  now: now,
                  userPresent: userPresent,
                  inUse: inUse,
                  alreadySigningIn: self.browserSignInAttempts[profileID]?.isCurrent == true)
        else { return nil }
        return (stored.profile, self.makeBrowserSignInAttempt(url: stored.profile.url))
    }

    private func makeBrowserSignInAttempt(url: URL) -> BrowserSignInAttempt {
        let attempt = BrowserSignInAttempt(id: UUID(), profileID: Self.profileID(url: url), url: url)
        if let previous = self.browserSignInAttempts[attempt.profileID] {
            previous.revoke()
            self.finishCommit(previous.id)
        }
        self.browserSignInAttempts[attempt.profileID] = attempt
        return attempt
    }

    func cancelBrowserSignIn(_ attempt: BrowserSignInAttempt) {
        guard self.browserSignInAttempts[attempt.profileID]?.id == attempt.id else { return }
        self.browserSignInAttempts.removeValue(forKey: attempt.profileID)?.revoke()
        self.finishCommit(attempt.id)
        self.reconcileCredentialTransition(profileID: attempt.profileID)
    }

    func saveBrowserSession(
        name: String,
        session: GatewayBrowserSession,
        attempt: BrowserSignInAttempt,
        renewingOnly: Bool = false) async throws -> MacGatewayProfile
    {
        try session.validate(for: attempt.url)
        return try await self.commit(
            name: name,
            credentials: Credentials(token: nil, password: nil, browserSession: session),
            attempt: attempt,
            renewingOnly: renewingOnly)
    }

    func saveConnection(
        name: String,
        token: String?,
        password: String?,
        attempt: BrowserSignInAttempt) async throws -> MacGatewayProfile
    {
        let saved = try self.loadRegistry().profiles.first { $0.profile.id == attempt.profileID }?.credentials
        return try await self.commit(
            name: name,
            credentials: Self.resolvedCredentials(saved: saved, submittedToken: token, submittedPassword: password),
            attempt: attempt)
    }

    private func commit(
        name: String,
        credentials: Credentials?,
        attempt: BrowserSignInAttempt,
        renewingOnly: Bool = false) async throws -> MacGatewayProfile
    {
        try self.requireCurrentAttempt(attempt)
        let old = try self.loadRegistry().profiles.first { $0.profile.id == attempt.profileID }
        let oldStoreID = old.map { Self.chatStoreID(profileID: $0.profile.id, credentials: $0.credentials) }
        let newStoreID = credentials.map { Self.chatStoreID(profileID: attempt.profileID, credentials: $0) }
        let changesPrincipal = oldStoreID != nil && oldStoreID != newStoreID
        let previousSession = old?.credentials.browserSession
        let nextSession = credentials?.browserSession
        // Only a still-live session preserves its dashboard. After expiry the
        // full sign-in path restores retired sockets and signed-out documents.
        let renewsBrowserSession = !changesPrincipal && nextSession != nil &&
            previousSession.map { $0.expiresAt > Date() } == true &&
            previousSession?.browserDataPrincipal == nextSession?.browserDataPrincipal
        // Automatic renewal never switches accounts or replaces an expired session.
        guard !renewingOnly || renewsBrowserSession,
              self.committingBrowserSignIns[attempt.id] == nil else { throw GatewayBrowserSessionError.superseded }
        self.committingBrowserSignIns[attempt.id] = CommitState(removesProfile: credentials == nil)
        self.credentialTransitions[attempt.profileID] = renewsBrowserSession
        defer {
            self.finishCommit(attempt.id)
            if self.browserSignInAttempts[attempt.profileID]?.id == attempt.id {
                self.reconcileCredentialTransition(profileID: attempt.profileID)
            }
        }
        if changesPrincipal {
            // Close account-owned presentations before a successor can publish
            // credentials. Their retained transports are revoked independently.
            await MainActor.run {
                guard attempt.isCurrent, !Task.isCancelled else { return }
                NotificationCenter.default.post(
                    name: Self.willChangePrincipalNotification,
                    object: nil,
                    userInfo: [Self.changedProfileIDKey: attempt.profileID])
            }
            try self.requireCurrentAttempt(attempt)
            _ = await MacGatewayConnectionFleet.shared.remove(
                profileID: attempt.profileID, ifCurrent: { attempt.isCurrent && !Task.isCancelled })
        } else if !renewsBrowserSession {
            await MacGatewayConnectionFleet.shared.disconnect(
                profileID: attempt.profileID, ifCurrent: { attempt.isCurrent && !Task.isCancelled })
        }
        try self.requireCurrentAttempt(attempt)
        if !renewsBrowserSession {
            try await DashboardBrowserSessionStore.prepareProfileChange(
                profileID: attempt.profileID,
                registryNamespace: Self.service,
                previous: previousSession,
                next: nextSession,
                ifCurrent: { attempt.isCurrent && !Task.isCancelled })
        }
        try self.requireCurrentAttempt(attempt)
        try credentials?.browserSession?.validate(for: attempt.url)
        if credentials?.browserSession != nil {
            // Join non-renewal sockets before revocation to prevent hello token writes.
            // Browser renewals cannot use or persist device tokens; keep them up until saved.
            guard let identity = DeviceIdentityStore.loadOrCreatePersisted(),
                  DeviceAuthStore.clearGatewayTokensPersisted(
                      deviceId: identity.deviceId, gatewayID: attempt.profileID)
            else { throw GatewayBrowserSessionError.credentialRetirementFailed }
        }
        let profile = try Self.makeProfile(name: name, url: attempt.url)
        var registry = try self.loadRegistry()
        registry.profiles.removeAll { $0.profile.id == profile.id }
        if let credentials { registry.profiles.append(StoredProfile(profile: profile, credentials: credentials)) }
        try self.saveRegistry(registry)
        // Once saved, cancellation must publish the new credentials or use normal
        // document recovery. A later attempt inherits any unfinished transition.
        self.credentialTransitions[profile.id] = false
        var renewedBrowserSession = false
        if renewsBrowserSession, let previousSession, let nextSession {
            await MacGatewayConnectionFleet.shared.disconnect(
                profileID: attempt.profileID, ifCurrent: { attempt.isCurrent && !Task.isCancelled })
            do {
                try await DashboardBrowserSessionStore.renewProfileSession(
                    profileID: profile.id,
                    registryNamespace: Self.service,
                    previous: previousSession,
                    next: nextSession,
                    ifCurrent: { attempt.isCurrent && !Task.isCancelled })
                renewedBrowserSession = true
            } catch {
                Self.logger.error("browser cookie renewal did not complete profile=\(profile.id, privacy: .public)")
            }
        }
        guard self.browserSignInAttempts[profile.id]?.id == attempt.id else {
            throw GatewayBrowserSessionError.superseded
        }
        self.browserSignInAttempts.removeValue(forKey: attempt.profileID)?.revoke()
        self.credentialTransitions.removeValue(forKey: profile.id)
        self.postChange(
            profileID: profile.id,
            removed: credentials == nil,
            changeID: attempt.id,
            renewedBrowserSession: renewedBrowserSession)
        return profile
    }

    private func requireCurrentAttempt(_ attempt: BrowserSignInAttempt) throws {
        try Task.checkCancellation()
        guard self.browserSignInAttempts[attempt.profileID]?.id == attempt.id, attempt.isCurrent else {
            throw GatewayBrowserSessionError.superseded
        }
    }

    private func reconcileCredentialTransition(profileID: String) {
        guard let renewal = self.credentialTransitions.removeValue(forKey: profileID) else { return }
        // Only the current attempt restores authoritative registry credentials
        // after retiring browser leases/cookies, including a failed renewal.
        let removed = self.cachedRegistry?.profiles.contains { $0.profile.id == profileID } != true
        self.postChange(profileID: profileID, removed: removed, renewedBrowserSession: renewal)
    }

    private static func chatStoreID(profileID: String, credentials: Credentials) -> String {
        credentials.browserSession?.chatStoreID(profileID: profileID) ?? profileID
    }

    func chatStoreID(profileID: String) async throws -> String {
        // Deletion retires the fleet before its registry commit. No new owner
        // may bind that still-present row during the awaited socket shutdown.
        while let attempt = self.browserSignInAttempts[profileID],
              self.committingBrowserSignIns[attempt.id]?.removesProfile == true
        {
            let waiterID = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
                    guard !Task.isCancelled else {
                        waiter.resume(throwing: CancellationError())
                        return
                    }
                    guard self.browserSignInAttempts[profileID]?.id == attempt.id,
                          self.committingBrowserSignIns[attempt.id]?.removesProfile == true
                    else {
                        waiter.resume()
                        return
                    }
                    self.committingBrowserSignIns[attempt.id]?.identityWaiters[waiterID] = waiter
                }
            } onCancel: {
                Task { await self.cancelIdentityWaiter(attemptID: attempt.id, waiterID: waiterID) }
            }
        }
        try Task.checkCancellation()
        return try self.storedChatStoreID(profileID: profileID)
    }

    private func finishCommit(_ id: UUID) {
        guard let commit = self.committingBrowserSignIns.removeValue(forKey: id) else { return }
        for waiter in commit.identityWaiters.values {
            waiter.resume()
        }
    }

    private func cancelIdentityWaiter(attemptID: UUID, waiterID: UUID) {
        self.committingBrowserSignIns[attemptID]?.identityWaiters.removeValue(forKey: waiterID)?
            .resume(throwing: CancellationError())
    }

    private func storedChatStoreID(profileID: String) throws -> String {
        guard let stored = try self.loadRegistry().profiles.first(where: { $0.profile.id == profileID }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        return Self.chatStoreID(profileID: profileID, credentials: stored.credentials)
    }

    func endpoint(profileID: String, expectedChatStoreID: String) throws -> GatewayConnection.EndpointSnapshot {
        guard try self.storedChatStoreID(profileID: profileID) == expectedChatStoreID else {
            throw GatewayBrowserSessionError.superseded
        }
        return try self.endpoint(profileID: profileID)
    }

    func profiles() throws -> [MacGatewayProfile] {
        try Self.sortedProfiles(self.loadRegistryMigratingLegacyPrimary().profiles.map(\.profile))
    }

    func catalogProfiles(retryKeychainAccess: Bool = false) throws -> [MacGatewayCatalogProfile] {
        if retryKeychainAccess {
            try Task.checkCancellation()
            self.keychainAccess.allowRetry()
        }
        let stored = try self.loadRegistryMigratingLegacyPrimary().profiles
        return Self.sortedProfiles(stored.map(\.profile)).compactMap { profile in
            guard let item = stored.first(where: { $0.profile.id == profile.id }) else { return nil }
            let token = item.credentials.token?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = item.credentials.password?.trimmingCharacters(in: .whitespacesAndNewlines)
            let browserSession = item.credentials.browserSession
            let authKind: MacGatewayCatalogProfile.AuthKind? = if browserSession != nil {
                .browser
            } else if token?.isEmpty == false {
                .token
            } else if password?.isEmpty == false {
                .password
            } else {
                nil
            }
            return MacGatewayCatalogProfile(
                profile: profile,
                canPromote: token?.isEmpty == false,
                usesBrowserIdentity: browserSession != nil,
                browserSessionExpiresAt: browserSession?.expiresAt,
                authKind: authKind,
                browserSessionSubject: browserSession?.subject)
        }
    }

    @discardableResult
    func remove(profileID: String) async throws -> UUID {
        try Task.checkCancellation()
        self.keychainAccess.allowRetry()
        guard let stored = try self.loadRegistry().profiles.first(where: { $0.profile.id == profileID }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let attempt = try self.beginBrowserSignIn(url: stored.profile.url)
        _ = try await self.commit(name: stored.profile.name, credentials: nil, attempt: attempt)
        return attempt.id
    }

    private func postChange(
        profileID: String, removed: Bool = false, changeID: UUID = UUID(), renewedBrowserSession: Bool = false)
    {
        NotificationCenter.default.post(
            name: Self.didChangeNotification,
            object: nil,
            userInfo: [
                Self.changedProfileIDKey: profileID,
                Self.removedProfileKey: removed,
                Self.changeIDKey: changeID,
                Self.renewedBrowserSessionKey: renewedBrowserSession,
            ])
    }

    struct BrowserSignInRequired: LocalizedError, Sendable {
        let profile: MacGatewayProfile
        let expiresAt: Date

        var errorDescription: String? {
            GatewayBrowserSessionError.expired.errorDescription
        }
    }

    func dashboardEndpoint(profileID: String) throws -> GatewayConnection.EndpointSnapshot {
        do {
            return try self.endpoint(profileID: profileID)
        } catch GatewayBrowserSessionError.expired {
            // endpoint already loaded this registry. Keep its credential-free failure
            // context within the same actor turn and injectable endpoint operation.
            guard let stored = try self.loadRegistry().profiles.first(where: { $0.profile.id == profileID }),
                  let session = stored.credentials.browserSession else { throw GatewayBrowserSessionError.expired }
            throw BrowserSignInRequired(profile: stored.profile, expiresAt: session.expiresAt)
        }
    }

    func endpoint(profileID: String) throws -> GatewayConnection.EndpointSnapshot {
        if let attempt = self.browserSignInAttempts[profileID],
           self.committingBrowserSignIns[attempt.id] != nil
        {
            // A window can request the profile connection while shutdown
            // suspends. It must not reacquire the credentials being retired.
            throw GatewayBrowserSessionError.superseded
        }
        let registry = try self.loadRegistry()
        guard let stored = registry.profiles.first(where: { $0.profile.id == profileID }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let url = try Self.canonicalURL(stored.profile.url)
        let browserSession = stored.credentials.browserSession
        try browserSession?.validate(for: url)
        return GatewayConnection.EndpointSnapshot(
            config: (
                url: url,
                token: browserSession == nil ? stored.credentials.token : nil,
                password: browserSession == nil ? stored.credentials.password : nil),
            tls: browserSession == nil ? Self.tlsRoute(for: stored.profile) : nil,
            routeAuthority: nil,
            deviceAuthGatewayID: browserSession == nil ? stored.profile.id : nil,
            browserSession: browserSession)
    }

    private func loadRegistry() throws -> Registry {
        if let cachedRegistry { return cachedRegistry }
        let registry: Registry = if let data = try self.load(account: Self.registryAccount) {
            try Self.decodeRegistry(data)
        } else {
            Registry()
        }
        self.cachedRegistry = registry
        return registry
    }

    private func loadRegistryMigratingLegacyPrimary() throws -> Registry {
        let registry = try self.loadRegistry()
        // Keep the receipt in the registry so removing the imported profile is durable.
        // A failed commit leaves both changes unapplied. Denied Keychain access
        // waits for an explicit retry instead of prompting on each catalog refresh.
        guard (registry.legacyPrimaryMigrationVersion ?? 0) < Self.currentLegacyPrimaryMigrationVersion else {
            return registry
        }
        let migrated = Self.migratingLegacyPrimaryConnection(
            root: OpenClawConfigFile.loadDict(),
            registry: registry)
        guard migrated != registry else { return registry }
        try self.saveRegistry(migrated)
        return migrated
    }

    private func saveRegistry(_ registry: Registry) throws {
        try self.save(JSONEncoder().encode(registry), account: Self.registryAccount)
        self.cachedRegistry = registry
    }

    private static func decodeRegistry(_ data: Data) throws -> Registry {
        let registry = try JSONDecoder().decode(Registry.self, from: data)
        guard registry.version == 1 else {
            throw MacGatewayProfileError.unsupportedRegistryVersion(registry.version)
        }
        return registry
    }

    static func validateRegistryData(_ data: Data) throws {
        _ = try MacGatewayProfileStore.decodeRegistry(data)
    }

    static func sortedProfiles(_ profiles: [MacGatewayProfile]) -> [MacGatewayProfile] {
        profiles.sorted { lhs, rhs in
            let nameOrder = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
            if nameOrder != .orderedSame {
                return nameOrder == .orderedAscending
            }
            return lhs.url.absoluteString.localizedCaseInsensitiveCompare(rhs.url.absoluteString) == .orderedAscending
        }
    }

    private static func makeProfile(name: String, url: URL) throws -> MacGatewayProfile {
        let canonicalURL = try self.canonicalURL(url)
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return MacGatewayProfile(
            id: self.profileID(url: canonicalURL),
            name: trimmedName.isEmpty ? (canonicalURL.host ?? canonicalURL.absoluteString) : trimmedName,
            url: canonicalURL)
    }

    static func canonicalURL(_ url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              ["ws", "wss"].contains(scheme),
              let host = components.host?.lowercased(),
              !host.isEmpty
        else { throw MacGatewayProfileError.invalidURL }
        if scheme == "ws", !GatewayRemoteConfig.allowsPlaintextGatewayHost(host) {
            throw MacGatewayProfileError.insecureRemoteURL
        }
        components.scheme = scheme
        components.host = host
        if components.port == nil {
            components.port = scheme == "wss" ? 443 : 18789
        }
        if components.percentEncodedPath.isEmpty {
            components.percentEncodedPath = "/"
        }
        components.fragment = nil
        guard let canonical = components.url else { throw MacGatewayProfileError.invalidURL }
        return canonical
    }

    static func profileID(url: URL) -> String {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return "manual-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    static func tlsRoute(for profile: MacGatewayProfile) -> GatewayTLSRoute? {
        GatewayTLSRoute.resolve(
            url: profile.url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storeKey: "profile:\(profile.id)")
    }

    static func resolvedCredentials(
        saved: Credentials?,
        submittedToken: String?,
        submittedPassword: String?) -> Credentials
    {
        let submitted = Credentials(
            token: submittedToken?.nonEmpty,
            password: submittedPassword?.nonEmpty)
        // An empty New Gateway form means "reuse this saved route", not
        // "erase its authentication". Supplying either field replaces both.
        if submitted.token == nil, submitted.password == nil {
            return saved ?? submitted
        }
        return submitted
    }

    private func load(account: String) throws -> Data? {
        var query = Self.baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = self.keychainAccess.perform { SecItemCopyMatching(query as CFDictionary, &result) }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw MacGatewayProfileError.keychain(status)
        }
        return data
    }

    private func save(_ data: Data, account: String) throws {
        let query = Self.baseQuery(account: account)
        let update = self.keychainAccess.perform {
            SecItemUpdate(
                query as CFDictionary,
                [kSecValueData as String: data] as CFDictionary)
        }
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw MacGatewayProfileError.keychain(update) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = self.keychainAccess.perform { SecItemAdd(add as CFDictionary, nil) }
        guard status == errSecSuccess else { throw MacGatewayProfileError.keychain(status) }
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

actor MacGatewayConnectionFleet {
    static let shared = MacGatewayConnectionFleet()

    private struct Owner {
        let chatStoreID: String
        let active: LockIsolated<Bool>
        let connection: GatewayConnection
    }

    private var connections: [String: Owner] = [:]
    private var ownerRevision: UInt64 = 0

    func boundProfileIDs() -> Set<String> {
        Set(self.connections.compactMap { key, owner in
            key.hasPrefix("profile:") && owner.connection.hasConnectedServer
                ? String(key.dropFirst("profile:".count)) : nil
        })
    }

    struct Binding {
        let connection: GatewayConnection
        let chatStoreID: String
    }

    func existingConnection(profileID: String) -> GatewayConnection? {
        self.connections["profile:\(profileID)"]?.connection
    }

    func existingLocalConnection() -> GatewayConnection? {
        self.connections["local"]?.connection
    }

    func localConnection() -> GatewayConnection {
        self.localBinding().connection
    }

    func localBinding() -> Binding {
        if let owner = self.connections["local"] {
            return Binding(connection: owner.connection, chatStoreID: owner.chatStoreID)
        }
        let chatStoreID = MacChatTranscriptCache.gatewayID(
            mode: .local,
            localStateDir: OpenClawPaths.stateDirURL,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 0)!
        let active = LockIsolated(true)
        let connection = GatewayConnection(
            endpointProvider: {
                let generation = await MainActor.run { () -> UInt64? in
                    let state = AppStateStore.shared
                    guard active.value, state.connectionMode == .remote,
                          state.hostsLocalGatewayWithRemotePrimary,
                          state.gatewayConfigIsCurrentForRouting
                    else { return nil }
                    return state.gatewayRoutingGeneration
                }
                guard let generation else { throw URLError(.notConnectedToInternet) }
                let root = OpenClawConfigFile.loadDict()
                guard ConnectionModeResolver.resolve(root: root).mode == .remote else { throw CancellationError() }
                let endpoint = try GatewayEndpointStore.localEndpoint(hostingBesideRemotePrimary: true, root: root)
                let isCurrent = await MainActor.run {
                    let state = AppStateStore.shared
                    return active.value && state.connectionMode == .remote &&
                        state.hostsLocalGatewayWithRemotePrimary && state.gatewayConfigIsCurrentForRouting &&
                        state.gatewayRoutingGeneration == generation
                }
                guard isCurrent else { throw CancellationError() }
                return endpoint
            },
            supportsSharedEndpointRecovery: false)
        self.connections["local"] = Owner(chatStoreID: chatStoreID, active: active, connection: connection)
        self.ownerRevision &+= 1
        return Binding(connection: connection, chatStoreID: chatStoreID)
    }

    func disconnectLocal(ifCurrent: @Sendable () -> Bool = { true }) async {
        await self.connections["local"]?.connection.shutdown(ifCurrent: ifCurrent)
    }

    func connection(profileID: String) async -> GatewayConnection {
        do {
            return try await self.binding(profileID: profileID).connection
        } catch {
            return GatewayConnection(endpointProvider: { throw error }, supportsSharedEndpointRecovery: false)
        }
    }

    func binding(profileID: String) async throws -> Binding {
        while true {
            let revision = self.ownerRevision
            let chatStoreID = try await MacGatewayProfileStore.shared.chatStoreID(profileID: profileID)
            // A delayed lookup cannot retire an owner admitted after it began,
            // including remove/re-add cycles with the same principal.
            guard revision == self.ownerRevision else { continue }
            if let owner = self.connections["profile:\(profileID)"] {
                if owner.chatStoreID == chatStoreID {
                    return Binding(connection: owner.connection, chatStoreID: chatStoreID)
                }
                _ = await self.remove(profileID: profileID)
                continue
            }
            let active = LockIsolated(true)
            let connection = GatewayConnection(
                endpointProvider: {
                    guard active.value else { throw GatewayBrowserSessionError.superseded }
                    let endpoint = try await MacGatewayProfileStore.shared.endpoint(
                        profileID: profileID, expectedChatStoreID: chatStoreID)
                    guard active.value else { throw GatewayBrowserSessionError.superseded }
                    return endpoint
                },
                supportsSharedEndpointRecovery: false)
            self.connections["profile:\(profileID)"] = Owner(
                chatStoreID: chatStoreID,
                active: active,
                connection: connection)
            self.ownerRevision &+= 1
            return Binding(connection: connection, chatStoreID: chatStoreID)
        }
    }

    func remove(profileID: String, ifCurrent: @Sendable () -> Bool = { true }) async -> GatewayConnection? {
        guard ifCurrent() else { return nil }
        self.ownerRevision &+= 1
        guard let owner = self.connections.removeValue(forKey: "profile:\(profileID)") else { return nil }
        // Revocation is permanent: signing back into the same account must not
        // revive a retained transport from a closed window or deleted profile.
        owner.active.withValue { $0 = false }
        await owner.connection.shutdown()
        return owner.connection
    }

    func disconnect(profileID: String, ifCurrent: @Sendable () -> Bool = { true }) async {
        // Renewals retain observers; changing principal retires the owner instead.
        await self.connections["profile:\(profileID)"]?.connection.shutdown(ifCurrent: ifCurrent)
    }

    func shutdown() async -> [GatewayConnection] {
        let owners = Array(self.connections.values)
        self.ownerRevision &+= 1
        self.connections.removeAll()
        for owner in owners {
            owner.active.withValue { $0 = false }
        }
        for owner in owners {
            await owner.connection.shutdown()
        }
        return owners.map(\.connection)
    }
}
