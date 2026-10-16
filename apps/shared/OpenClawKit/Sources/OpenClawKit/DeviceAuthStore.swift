import Foundation
import OpenClawNativeState

public struct DeviceAuthEntry: Codable, Sendable, Equatable {
    public let token: String
    public let role: String
    public let scopes: [String]
    public let updatedAtMs: Int64
    public let gatewayID: String?

    public init(token: String, role: String, scopes: [String], updatedAtMs: Int64, gatewayID: String? = nil) {
        self.token = token
        self.role = role
        self.scopes = scopes
        self.updatedAtMs = updatedAtMs
        self.gatewayID = gatewayID
    }
}

struct DeviceAuthStoreFile: Codable, Equatable {
    var version: Int
    var deviceId: String
    var tokens: [String: DeviceAuthEntry]
}

public enum DeviceAuthStore {
    static let maximumLegacyAuthBytes = 4 * 1024 * 1024

    private static func perform(
        _ operation: ClientCredentialOperation,
        profile: GatewayDeviceIdentityProfile) throws -> ClientCredentialResult
    {
        try DeviceCredentialAccess.execute(root: DeviceIdentityPaths.stateDirURL(), operation: operation)
    }

    public static func loadToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry?
    {
        guard let key = tokenKey(role: role, gatewayID: gatewayID) else { return nil }
        var operation = ClientCredentialOperation(kind: .tokenRead)
        operation.key = .init(deviceID: deviceId, role: key)
        guard let row = try? perform(operation, profile: profile).token,
              let scopes = decodeScopes(row.scopesJSON) else { return nil }
        let decoded = self.decodeTokenKey(row.role)
        return DeviceAuthEntry(
            token: row.token,
            role: decoded.role,
            scopes: scopes,
            updatedAtMs: row.updatedAtMs,
            gatewayID: decoded.gatewayID)
    }

    public static func observeTokens(
        deviceId: String,
        gatewayID: String?,
        profile: GatewayDeviceIdentityProfile = .primary) -> [String: String]
    {
        var observed: [String: String] = [:]
        var afterRole: String?
        repeat {
            var operation = ClientCredentialOperation(kind: .tokenList)
            operation.device_id = deviceId
            operation.afterRole = afterRole
            guard let result = try? perform(operation, profile: profile) else { return observed }
            for row in result.tokens ?? [] {
                let decoded = self.decodeTokenKey(row.role)
                if decoded.gatewayID.map({ Data($0.utf8) }) == gatewayID.map({ Data($0.utf8) }) {
                    observed[decoded.role] = row.token
                }
            }
            afterRole = result.nextRole
        } while afterRole != nil
        return observed
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry
    {
        self.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: scopes,
            gatewayID: gatewayID,
            profile: profile).entry
    }

    @discardableResult public static func storeTokenPersisted(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary,
        expectedToken: String? = nil,
        onlyIfUnchanged: Bool = false) -> Bool
    {
        self.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: scopes,
            gatewayID: gatewayID,
            profile: profile,
            expectedToken: expectedToken,
            onlyIfUnchanged: onlyIfUnchanged).persisted
    }

    static func storeTokenResult(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary,
        expectedToken: String? = nil,
        onlyIfUnchanged: Bool = false) -> (entry: DeviceAuthEntry, persisted: Bool)
    {
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizeRole(role),
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            gatewayID: gatewayID)
        guard let key = tokenKey(role: role, gatewayID: gatewayID),
              let encoded = try? JSONEncoder().encode(entry.scopes) else { return (entry, false) }
        var operation = ClientCredentialOperation(kind: .tokenReplace)
        operation.key = .init(deviceID: deviceId, role: key)
        operation.token = .init(
            deviceID: deviceId,
            role: key,
            token: token,
            scopesJSON: String(bytes: encoded, encoding: .utf8)!,
            updatedAtMs: entry.updatedAtMs)
        operation.hasExpectedToken = onlyIfUnchanged
        operation.expectedToken = expectedToken
        return (entry, (try? self.perform(operation, profile: profile).changed) == true)
    }

    public static func clearToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary,
        observedToken: String? = nil)
    {
        if gatewayID == nil, observedToken == nil {
            _ = self.clear(
                deviceId: deviceId,
                selector: .init(kind: .role, role: self.normalizeRole(role)),
                profile: profile)
            return
        }
        guard let key = tokenKey(role: role, gatewayID: gatewayID) else { return }
        var operation = ClientCredentialOperation(kind: .tokenRemove)
        operation.key = .init(deviceID: deviceId, role: key)
        operation.observedToken = observedToken
        _ = try? self.perform(operation, profile: profile)
    }

    public static func clearAll(profile: GatewayDeviceIdentityProfile = .primary) {
        var operation = ClientCredentialOperation(kind: .identityRead)
        operation.identity_key = profile.rawValue
        guard let identity = try? DeviceCredentialAccess.execute(
            root: DeviceIdentityPaths.stateDirURL(),
            operation: operation).identity else { return }
        _ = self.clear(deviceId: identity.deviceID, selector: .init(kind: .all), profile: profile)
    }

    public static func clearGatewayTokensPersisted(
        deviceId: String,
        gatewayID: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Bool
    {
        self.clear(deviceId: deviceId, selector: .init(kind: .gateway, gateway: gatewayID), profile: profile) != nil
    }

    @discardableResult public static func migrateUnscopedToken(
        deviceId: String,
        role: String,
        toGatewayID gatewayID: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Bool
    {
        guard !gatewayID.isEmpty else { return false }
        var operation = ClientCredentialOperation(kind: .nativeTokenClaim)
        operation.device_id = deviceId
        operation.role = self.normalizeRole(role)
        operation.gateway = gatewayID
        return (try? self.perform(operation, profile: profile).changed) == true
    }

    @discardableResult public static func discardUnscopedTokens(
        deviceId: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Int
    {
        self.clear(deviceId: deviceId, selector: .init(kind: .unscoped), profile: profile) ?? 0
    }

    private static func clear(
        deviceId: String,
        selector: ClientCredentialOperation.Selector,
        profile: GatewayDeviceIdentityProfile) -> Int?
    {
        var operation = ClientCredentialOperation(kind: .nativeTokensClear)
        operation.device_id = deviceId
        operation.selector = selector
        return try? self.perform(operation, profile: profile).count
    }

    static func prepareLegacy(
        owner: OpenClawClientCredentialStore,
        profile: GatewayDeviceIdentityProfile,
        stateDirectoryURL: URL,
        fallback: DeviceAuthStoreFile? = nil) throws
    {
        let key = "auth:\(profile.rawValue)"
        guard try owner.readReceipt()?.receipt.legacyImports[key] == nil else { return }
        let url = self.legacyFileURL(stateDirectoryURL: stateDirectoryURL, profile: profile)
        let store = try self.readLegacyFile(url) ?? fallback
        let tokens = try store?.tokens.map { key, entry in
            try OpenClawClientCredentialStore.Token(
                deviceID: store!.deviceId,
                role: key,
                token: entry.token,
                scopesJSON: String(bytes: JSONEncoder().encode(entry.scopes), encoding: .utf8)!,
                updatedAtMs: entry.updatedAtMs)
        } ?? []
        _ = try owner.importLegacy(key: key, sha256: nil, tokens: tokens)
    }

    static func readLegacyFile(_ url: URL, deviceID: String? = nil) throws -> DeviceAuthStoreFile? {
        guard let data = try DeviceIdentitySQLiteStore.readLegacyFile(
            url,
            beneath: url.deletingLastPathComponent().deletingLastPathComponent(),
            maximumBytes: self.maximumLegacyAuthBytes) else { return nil }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data),
              let store = self.normalizedStore(decoded), deviceID == nil || store.deviceId == deviceID
        else {
            throw DeviceIdentityStore.storageError("Legacy device auth is invalid; source preserved")
        }
        return store
    }

    static func normalizedStore(_ decoded: DeviceAuthStoreFile) -> DeviceAuthStoreFile? {
        guard decoded.version == 1 else { return nil }
        // Entries carry their owner, so migration compares one canonical role/scope/owner map
        // instead of depending on raw JSON key order or obsolete dictionary keys.
        var tokens: [String: DeviceAuthEntry] = [:]
        for entry in decoded.tokens.values {
            let role = self.normalizeRole(entry.role)
            let gatewayID = self.normalizeGatewayID(entry.gatewayID)
            guard entry.gatewayID == nil || gatewayID != nil,
                  let key = tokenKey(role: role, gatewayID: gatewayID)
            else { continue }
            let normalized = DeviceAuthEntry(
                token: entry.token,
                role: role,
                scopes: self.normalizeScopes(entry.scopes),
                updatedAtMs: entry.updatedAtMs,
                gatewayID: gatewayID)
            if let existing = tokens[key] {
                if existing.updatedAtMs > normalized.updatedAtMs {
                    continue
                }
                if existing.updatedAtMs == normalized.updatedAtMs, existing != normalized {
                    return nil
                }
            }
            tokens[key] = normalized
        }
        return DeviceAuthStoreFile(version: 1, deviceId: decoded.deviceId, tokens: tokens)
    }

    private static func decodeScopes(_ rawJSON: String) -> [String]? {
        guard let values = jsonArray(rawJSON) else { return nil }
        return self.normalizeScopes(values.compactMap { $0 as? String })
    }

    private static func jsonArray(_ rawJSON: String) -> [Any]? {
        try? JSONSerialization.jsonObject(with: Data(rawJSON.utf8)) as? [Any]
    }

    private static func decodeTokenKey(_ key: String) -> (role: String, gatewayID: String?) {
        let decoded = NativeCredentialTokenKey.decode(key)
        return (decoded.role, decoded.gateway)
    }

    private static func normalizeRole(_ role: String) -> String {
        role.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeGatewayID(_ gatewayID: String?) -> String? {
        guard let gatewayID, !gatewayID.isEmpty else { return nil }
        return gatewayID
    }

    private static func tokenKey(role: String, gatewayID: String?) -> String? {
        let normalizedRole = self.normalizeRole(role)
        guard !normalizedRole.isEmpty else { return nil }
        guard let gatewayID else { return normalizedRole }
        guard let gatewayID = normalizeGatewayID(gatewayID) else { return nil }
        return NativeCredentialTokenKey.encode(role: normalizedRole, gateway: gatewayID)
    }

    private static func normalizeScopes(_ scopes: [String]) -> [String] {
        let trimmed = scopes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(trimmed)).sorted()
    }

    private static func legacyFileURL(
        stateDirectoryURL: URL,
        profile: GatewayDeviceIdentityProfile) -> URL
    {
        stateDirectoryURL
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.authFileName, isDirectory: false)
    }

    static func isMissingFileError(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain
            && (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError))
            || (error.domain == NSPOSIXErrorDomain
                && error.code == Int(POSIXErrorCode.ENOENT.rawValue))
    }
}
