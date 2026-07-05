import Foundation
import OpenClawKit
import os

enum GatewaySettingsStore {
    private static let gatewayService = "ai.openclawfoundation.app.gateway"
    private static let nodeService = "ai.openclawfoundation.app.node"
    private static let talkService = "ai.openclawfoundation.app.talk"

    private static let instanceIdDefaultsKey = "node.instanceId"
    private static let preferredGatewayStableIDDefaultsKey = "gateway.preferredStableID"
    private static let lastDiscoveredGatewayStableIDDefaultsKey = "gateway.lastDiscoveredStableID"
    private static let lastGatewayKindDefaultsKey = "gateway.last.kind"
    private static let lastGatewayHostDefaultsKey = "gateway.last.host"
    private static let lastGatewayPortDefaultsKey = "gateway.last.port"
    private static let lastGatewayTlsDefaultsKey = "gateway.last.tls"
    private static let lastGatewayStableIDDefaultsKey = "gateway.last.stableID"
    private static let clientIdOverrideDefaultsPrefix = "gateway.clientIdOverride."
    private static let selectedAgentDefaultsPrefix = "gateway.selectedAgentId."

    private static let instanceIdAccount = "instanceId"
    private static let preferredGatewayStableIDAccount = "preferredStableID"
    private static let lastDiscoveredGatewayStableIDAccount = "lastDiscoveredStableID"
    private static let lastGatewayConnectionAccount = "lastConnection"
    private static let talkProviderApiKeyAccountPrefix = "provider.apiKey." // pragma: allowlist secret

    struct GatewayCredentialMetadata: Codable, Equatable {
        let gatewayStableID: String
        let suppressStoredDeviceAuth: Bool
    }

    /// Credential ownership and secrets must move together. Separate Keychain
    /// entries can survive a partial update and bind one gateway's secret to another.
    private struct GatewayCredentialBundle: Codable {
        let gatewayStableID: String
        let suppressStoredDeviceAuth: Bool
        let token: String?
        let bootstrapToken: String?
        let password: String?
    }

    struct GatewayCredentials: Equatable {
        let token: String?
        let bootstrapToken: String?
        let password: String?
        let suppressStoredDeviceAuth: Bool

        static let empty = GatewayCredentials(
            token: nil,
            bootstrapToken: nil,
            password: nil,
            suppressStoredDeviceAuth: false)

        var hasCredentials: Bool {
            self.token != nil || self.bootstrapToken != nil || self.password != nil
        }
    }

    static func bootstrapPersistence() {
        self.ensureStableInstanceID()
        self.ensurePreferredGatewayStableID()
        self.ensureLastDiscoveredGatewayStableID()
    }

    static func currentInstanceID(defaults: UserDefaults = .standard) -> String {
        self.bootstrapPersistence()
        if let value = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }
        return self.loadStableInstanceID() ?? ""
    }

    static func loadStableInstanceID() -> String? {
        if let value = KeychainStore.loadString(service: self.nodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func saveStableInstanceID(_ instanceId: String) {
        _ = KeychainStore.saveString(instanceId, service: self.nodeService, account: self.instanceIdAccount)
    }

    static func loadPreferredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func savePreferredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
    }

    static func clearPreferredGatewayStableID(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
        defaults.removeObject(forKey: self.preferredGatewayStableIDDefaultsKey)
    }

    static func loadLastDiscoveredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func saveLastDiscoveredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
    }

    static func clearLastDiscoveredGatewayStableID(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
        defaults.removeObject(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
    }

    static func loadGatewayCredentialMetadata(instanceId: String) -> GatewayCredentialMetadata? {
        guard let bundle = self.loadGatewayCredentialBundle(instanceId: instanceId) else { return nil }
        return GatewayCredentialMetadata(
            gatewayStableID: bundle.gatewayStableID,
            suppressStoredDeviceAuth: bundle.suppressStoredDeviceAuth)
    }

    static func loadGatewayCredentials(instanceId: String, gatewayStableID: String) -> GatewayCredentials {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard !stableID.isEmpty,
              let bundle = self.loadGatewayCredentialBundle(instanceId: instanceId),
              bundle.gatewayStableID == stableID
        else { return .empty }
        return GatewayCredentials(
            token: bundle.token,
            bootstrapToken: bundle.bootstrapToken,
            password: bundle.password,
            suppressStoredDeviceAuth: bundle.suppressStoredDeviceAuth)
    }

    @discardableResult
    static func saveGatewayCredentials(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        gatewayStableID: String,
        suppressStoredDeviceAuth: Bool,
        instanceId: String) -> Bool
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stableID.isEmpty, !trimmedInstanceID.isEmpty else { return false }
        let bundle = GatewayCredentialBundle(
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: suppressStoredDeviceAuth,
            token: self.normalizedCredential(token),
            bootstrapToken: self.normalizedCredential(bootstrapToken),
            password: self.normalizedCredential(password))
        let account = self.gatewayCredentialBundleAccount(instanceId: trimmedInstanceID)
        let hasCredentials = bundle.token != nil || bundle.bootstrapToken != nil || bundle.password != nil
        guard hasCredentials || suppressStoredDeviceAuth else {
            let deleted = KeychainStore.delete(service: self.gatewayService, account: account)
            self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
            return deleted || KeychainStore.loadString(service: self.gatewayService, account: account) == nil
        }
        guard let data = try? JSONEncoder().encode(bundle),
              let json = String(data: data, encoding: .utf8)
        else {
            _ = KeychainStore.delete(service: self.gatewayService, account: account)
            return false
        }
        guard KeychainStore.saveString(
            json,
            service: self.gatewayService,
            account: account)
        else {
            // The Keychain helper restores the prior item when replacement fails. Keep that
            // known-good bundle; callers already treat this attempted update as uncommitted.
            return false
        }
        self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
        return true
    }

    @discardableResult
    static func updateGatewayCredentials(
        token: String?,
        password: String?,
        gatewayStableID: String,
        instanceId: String) -> Bool
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        let existing = self.loadGatewayCredentialBundle(instanceId: instanceId)
        let sameOwner = existing?.gatewayStableID == stableID
        return self.saveGatewayCredentials(
            token: token,
            bootstrapToken: sameOwner ? existing?.bootstrapToken : nil,
            password: password,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: sameOwner && existing?.suppressStoredDeviceAuth == true,
            instanceId: instanceId)
    }

    @discardableResult
    static func completeGatewayCredentialHandoff(instanceId: String, gatewayStableID: String) -> Bool {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard let bundle = self.loadGatewayCredentialBundle(instanceId: instanceId),
              bundle.gatewayStableID == stableID,
              bundle.suppressStoredDeviceAuth
        else { return false }
        // Device-token issuance and bootstrap consumption are one durable handoff. A relaunch
        // must never observe a spent bootstrap token while stored device auth remains disabled.
        return self.saveGatewayCredentials(
            token: bundle.token,
            bootstrapToken: nil,
            password: bundle.password,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceId)
    }

    static func discardUnscopedGatewayCredentials(instanceId: String) {
        // The legacy UI saved fields before a successful connection, so the last route
        // cannot prove who owns these secrets. Re-entry is safer than cross-gateway reuse.
        self.deleteLegacyGatewayCredentials(instanceId: instanceId)
    }

    /// Certificate pins prove transport trust for one route; they are not gateway identities.
    /// Wildcard certificates and reverse proxies may legitimately reuse a leaf certificate.
    static func authenticationOwnerID(routeStableID: String) -> String {
        routeStableID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    static func migrateProvenRelayCredentials(
        instanceId: String,
        gatewayStableID: String,
        token: String?,
        password: String?) -> Bool
    {
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let stableID = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstanceID.isEmpty, !stableID.isEmpty else { return false }
        let legacyAccounts = [
            self.gatewayTokenAccount(instanceId: trimmedInstanceID),
            self.gatewayBootstrapTokenAccount(instanceId: trimmedInstanceID),
            self.gatewayPasswordAccount(instanceId: trimmedInstanceID),
        ]
        let hasLegacyCredentials = legacyAccounts.contains { account in
            self.normalizedCredential(KeychainStore.loadString(
                service: self.gatewayService,
                account: account)) != nil
        }
        guard hasLegacyCredentials else { return true }

        // A canonical bundle already owns the fields atomically. Never replace it with
        // older relay data merely because legacy per-field entries still exist.
        if self.loadGatewayCredentialBundle(instanceId: trimmedInstanceID) != nil {
            self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
            return true
        }

        let relayToken = self.normalizedCredential(token)
        let relayPassword = self.normalizedCredential(password)
        guard relayToken != nil || relayPassword != nil else {
            self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
            return true
        }
        // Relay config is written only after a successful connection and therefore proves
        // both the credential values and their gateway owner. Preserve it before cleanup.
        return self.saveGatewayCredentials(
            token: relayToken,
            bootstrapToken: nil,
            password: relayPassword,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: false,
            instanceId: trimmedInstanceID)
    }

    static func saveLegacyGatewayTokenForMigrationTest(_ token: String, instanceId: String) {
        _ = KeychainStore.saveString(
            token,
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
    }

    enum LastGatewayConnection: Equatable {
        case manual(host: String, port: Int, useTLS: Bool, stableID: String)
        case discovered(stableID: String, useTLS: Bool)
    }

    private enum LastGatewayKind: String, Codable {
        case manual
        case discovered
    }

    /// JSON-serializable envelope stored as a single Keychain entry.
    private struct LastGatewayConnectionData: Codable {
        var kind: LastGatewayKind
        var stableID: String
        var useTLS: Bool
        var host: String?
        var port: Int?
    }

    static func loadTalkProviderApiKey(provider: String) -> String? {
        guard let providerId = self.normalizedTalkProviderID(provider) else { return nil }
        let account = self.talkProviderApiKeyAccount(providerId: providerId)
        let value = KeychainStore.loadString(
            service: self.talkService,
            account: account)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveLastGatewayConnectionManual(host: String, port: Int, useTLS: Bool, stableID: String) {
        let payload = LastGatewayConnectionData(
            kind: .manual, stableID: stableID, useTLS: useTLS, host: host, port: port)
        self.saveLastGatewayConnectionData(payload)
    }

    static func saveLastGatewayConnectionDiscovered(stableID: String, useTLS: Bool) {
        let payload = LastGatewayConnectionData(
            kind: .discovered, stableID: stableID, useTLS: useTLS)
        self.saveLastGatewayConnectionData(payload)
    }

    static func loadLastGatewayConnection() -> LastGatewayConnection? {
        // Migrate legacy UserDefaults entries on first access.
        self.migrateLastGatewayFromUserDefaultsIfNeeded()

        guard let json = KeychainStore.loadString(
            service: self.gatewayService, account: self.lastGatewayConnectionAccount),
            let data = json.data(using: .utf8),
            let stored = try? JSONDecoder().decode(LastGatewayConnectionData.self, from: data)
        else { return nil }

        let stableID = stored.stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stableID.isEmpty else { return nil }

        if stored.kind == .discovered {
            return .discovered(stableID: stableID, useTLS: stored.useTLS)
        }

        let host = (stored.host ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let port = stored.port ?? 0
        guard !host.isEmpty, port > 0, port <= 65535 else { return nil }
        return .manual(host: host, port: port, useTLS: stored.useTLS, stableID: stableID)
    }

    static func clearLastGatewayConnection(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(
            service: self.gatewayService, account: self.lastGatewayConnectionAccount)
        // Clean up any legacy UserDefaults entries.
        defaults.removeObject(forKey: self.lastGatewayKindDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayHostDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayPortDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayTlsDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayStableIDDefaultsKey)
    }

    @discardableResult
    private static func saveLastGatewayConnectionData(_ payload: LastGatewayConnectionData) -> Bool {
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return false }
        return KeychainStore.saveString(
            json, service: self.gatewayService, account: self.lastGatewayConnectionAccount)
    }

    /// Migrate legacy UserDefaults gateway.last.* keys into a single Keychain entry.
    private static func migrateLastGatewayFromUserDefaultsIfNeeded() {
        let defaults = UserDefaults.standard
        let stableID = defaults.string(forKey: self.lastGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !stableID.isEmpty else { return }

        // Already migrated if Keychain entry exists.
        if KeychainStore.loadString(
            service: self.gatewayService, account: self.lastGatewayConnectionAccount) != nil
        {
            // Clean up legacy keys.
            self.removeLastGatewayDefaults(defaults)
            return
        }

        let useTLS = defaults.bool(forKey: self.lastGatewayTlsDefaultsKey)
        let kindRaw = defaults.string(forKey: self.lastGatewayKindDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let kind = LastGatewayKind(rawValue: kindRaw) ?? .manual
        let host = defaults.string(forKey: self.lastGatewayHostDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let port = defaults.object(forKey: self.lastGatewayPortDefaultsKey) as? Int

        let payload = LastGatewayConnectionData(
            kind: kind,
            stableID: stableID,
            useTLS: useTLS,
            host: kind == .manual ? host : nil,
            port: kind == .manual ? port : nil)
        guard self.saveLastGatewayConnectionData(payload) else { return }
        self.removeLastGatewayDefaults(defaults)
    }

    private static func removeLastGatewayDefaults(_ defaults: UserDefaults) {
        defaults.removeObject(forKey: self.lastGatewayKindDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayHostDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayPortDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayTlsDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayStableIDDefaultsKey)
    }

    static func deleteGatewayCredentials(instanceId: String) {
        let trimmed = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayCredentialBundleAccount(instanceId: trimmed))
        self.deleteLegacyGatewayCredentials(instanceId: trimmed)
    }

    static func loadGatewayClientIdOverride(stableID: String) -> String? {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return nil }
        let key = self.clientIdOverrideDefaultsPrefix + trimmedID
        let value = UserDefaults.standard.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveGatewayClientIdOverride(stableID: String, clientId: String?) {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return }
        let key = self.clientIdOverrideDefaultsPrefix + trimmedID
        let trimmedClientId = clientId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedClientId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedClientId, forKey: key)
        }
    }

    static func loadGatewaySelectedAgentId(stableID: String) -> String? {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return nil }
        let key = self.selectedAgentDefaultsPrefix + trimmedID
        let value = UserDefaults.standard.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveGatewaySelectedAgentId(stableID: String, agentId: String?) {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return }
        let key = self.selectedAgentDefaultsPrefix + trimmedID
        let trimmedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedAgentId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedAgentId, forKey: key)
        }
    }

    private static func gatewayTokenAccount(instanceId: String) -> String {
        "gateway-token.\(instanceId)"
    }

    private static func gatewayBootstrapTokenAccount(instanceId: String) -> String {
        "gateway-bootstrap-token.\(instanceId)"
    }

    private static func gatewayPasswordAccount(instanceId: String) -> String {
        "gateway-password.\(instanceId)"
    }

    private static func gatewayCredentialBundleAccount(instanceId: String) -> String {
        "gateway-credentials.\(instanceId)"
    }

    private static func loadGatewayCredentialBundle(instanceId: String) -> GatewayCredentialBundle? {
        guard let json = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayCredentialBundleAccount(instanceId: instanceId)),
            let data = json.data(using: .utf8),
            let decoded = try? JSONDecoder().decode(GatewayCredentialBundle.self, from: data)
        else { return nil }
        let stableID = decoded.gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stableID.isEmpty else { return nil }
        return GatewayCredentialBundle(
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: decoded.suppressStoredDeviceAuth,
            token: self.normalizedCredential(decoded.token),
            bootstrapToken: self.normalizedCredential(decoded.bootstrapToken),
            password: self.normalizedCredential(decoded.password))
    }

    private static func normalizedCredential(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func deleteLegacyGatewayCredentials(instanceId: String) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayBootstrapTokenAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: "gateway-credential-metadata.\(instanceId)")
    }

    private static func talkProviderApiKeyAccount(providerId: String) -> String {
        self.talkProviderApiKeyAccountPrefix + providerId
    }

    private static func normalizedTalkProviderID(_ provider: String) -> String? {
        let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func ensureStableInstanceID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadStableInstanceID() == nil {
                self.saveStableInstanceID(existing)
            }
            return
        }

        if let stored = self.loadStableInstanceID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.instanceIdDefaultsKey)
            return
        }

        let fresh = UUID().uuidString
        self.saveStableInstanceID(fresh)
        defaults.set(fresh, forKey: self.instanceIdDefaultsKey)
    }

    private static func ensurePreferredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.preferredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadPreferredGatewayStableID() == nil {
                self.savePreferredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadPreferredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.preferredGatewayStableIDDefaultsKey)
        }
    }

    private static func ensureLastDiscoveredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadLastDiscoveredGatewayStableID() == nil {
                self.saveLastDiscoveredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadLastDiscoveredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
        }
    }
}

enum GatewayDiagnostics {
    struct ScopedLogger {
        private let prefix: String

        fileprivate init(prefix: String) {
            self.prefix = prefix
        }

        func stage(_ message: String) {
            GatewayDiagnostics.log("\(self.prefix): \(GatewayDiagnostics.sanitizeScopedMessage(message))")
        }

        func skipped(_ reason: String) {
            self.stage("registration skipped reason=\(reason)")
        }

        func failed(_ stage: String, error: Error) {
            let nsError = error as NSError
            let errorType = String(reflecting: type(of: error))
            self
                .stage(
                    "\(stage) failed errorType=\(errorType) domain=\(nsError.domain) code=\(nsError.code)")
        }
    }

    private static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "GatewayDiag")
    private static let queue = DispatchQueue(label: "ai.openclawfoundation.app.gateway.diagnostics")
    private static let maxLogBytes: Int64 = 512 * 1024
    private static let keepLogBytes: Int64 = 256 * 1024
    private static let logSizeCheckEveryWrites = 50
    private static let logWritesSinceCheck = OSAllocatedUnfairLock(initialState: 0)
    private static let maxScopedMessageCharacters = 320

    /// Keep relay diagnostics stage-based. Push tokens, relay grants, proofs,
    /// receipts, signed payloads, and handles must never enter this cache log.
    static let pushRelay = ScopedLogger(prefix: "push relay")

    private static func sanitizeScopedMessage(_ value: String) -> String {
        let collapsed = value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard collapsed.count > self.maxScopedMessageCharacters else {
            return collapsed
        }
        let end = collapsed.index(collapsed.startIndex, offsetBy: self.maxScopedMessageCharacters)
        return String(collapsed[..<end]) + "..."
    }

    private static func isoTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static var fileURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("openclaw-gateway.log")
    }

    private static func truncateLogIfNeeded(url: URL) {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let sizeNumber = attrs[.size] as? NSNumber
        else { return }
        let size = sizeNumber.int64Value
        guard size > self.maxLogBytes else { return }

        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }

            let start = max(Int64(0), size - self.keepLogBytes)
            try handle.seek(toOffset: UInt64(start))
            var tail = try handle.readToEnd() ?? Data()

            // If we truncated mid-line, drop the first partial line so logs remain readable.
            if start > 0, let nl = tail.firstIndex(of: 10) {
                let next = tail.index(after: nl)
                if next < tail.endIndex {
                    tail = tail.suffix(from: next)
                } else {
                    tail = Data()
                }
            }

            try tail.write(to: url, options: .atomic)
        } catch {
            // Best-effort only.
        }
    }

    private static func appendToLog(url: URL, data: Data) {
        if FileManager.default.fileExists(atPath: url.path) {
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    private static func applyFileProtection(url: URL) {
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path)
    }

    static func bootstrap() {
        guard let url = fileURL else { return }
        self.queue.async {
            self.truncateLogIfNeeded(url: url)
            let timestamp = self.isoTimestamp()
            let line = "[\(timestamp)] gateway diagnostics started\n"
            if let data = line.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
                self.applyFileProtection(url: url)
            }
        }
    }

    static func log(_ message: String) {
        let timestamp = self.isoTimestamp()
        let line = "[\(timestamp)] \(message)"
        self.logger.info("\(line, privacy: .public)")

        guard let url = fileURL else { return }
        self.queue.async {
            let shouldTruncate = self.logWritesSinceCheck.withLock { count in
                count += 1
                if count >= self.logSizeCheckEveryWrites {
                    count = 0
                    return true
                }
                return false
            }
            if shouldTruncate {
                self.truncateLogIfNeeded(url: url)
            }
            let entry = line + "\n"
            if let data = entry.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
            }
        }
    }
}
