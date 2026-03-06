import Foundation

public struct DeviceAuthEntry: Codable, Sendable {
    public let token: String
    public let role: String
    public let scopes: [String]
    public let updatedAtMs: Int

    public init(token: String, role: String, scopes: [String], updatedAtMs: Int) {
        self.token = token
        self.role = role
        self.scopes = scopes
        self.updatedAtMs = updatedAtMs
    }
}

private struct DeviceAuthStoreFile: Codable {
    var version: Int
    var deviceId: String
    var tokens: [String: DeviceAuthEntry]
}

public enum DeviceAuthStore {
    private static let fileName = "device-auth.json"
    private static let scopedTokenSeparator = "\u{1F}"

    public static func loadToken(
        deviceId: String,
        role: String,
        authScope: String? = nil
    ) -> DeviceAuthEntry? {
        guard let store = readStore(), store.deviceId == deviceId else { return nil }
        let role = normalizeRole(role)
        let normalizedAuthScope = normalizeAuthScope(authScope)
        if let normalizedAuthScope {
            let key = tokenKey(role: role, authScope: normalizedAuthScope)
            return store.tokens[key]
        }
        return store.tokens[tokenKey(role: role, authScope: nil)]
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        authScope: String? = nil
    ) -> DeviceAuthEntry {
        let normalizedRole = normalizeRole(role)
        let normalizedAuthScope = normalizeAuthScope(authScope)
        var next = readStore()
        if next?.deviceId != deviceId {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int(Date().timeIntervalSince1970 * 1000)
        )
        if next == nil {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let key = tokenKey(role: normalizedRole, authScope: normalizedAuthScope)
        next?.tokens[key] = entry
        if let store = next {
            writeStore(store)
        }
        return entry
    }

    public static func clearToken(
        deviceId: String,
        role: String,
        authScope: String? = nil
    ) {
        guard var store = readStore(), store.deviceId == deviceId else { return }
        let normalizedRole = normalizeRole(role)
        let key = tokenKey(role: normalizedRole, authScope: normalizeAuthScope(authScope))
        guard store.tokens[key] != nil else { return }
        store.tokens.removeValue(forKey: key)
        writeStore(store)
    }

    private static func normalizeRole(_ role: String) -> String {
        role.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeScopes(_ scopes: [String]) -> [String] {
        let trimmed = scopes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(trimmed)).sorted()
    }

    private static func normalizeAuthScope(_ authScope: String?) -> String? {
        let trimmed = authScope?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func tokenKey(role: String, authScope: String?) -> String {
        guard let authScope else { return role }
        return authScope + scopedTokenSeparator + role
    }

    private static func fileURL() -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    private static func readStore() -> DeviceAuthStoreFile? {
        let url = fileURL()
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data) else {
            return nil
        }
        guard decoded.version == 1 else { return nil }
        return decoded
    }

    private static func writeStore(_ store: DeviceAuthStoreFile) {
        let url = fileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(store)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // best-effort only
        }
    }
}
