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
    private static let stateScope = "identity.device-auth"
    private static let stateKey = "default"

    public static func loadToken(deviceId: String, role: String) -> DeviceAuthEntry? {
        guard let store = readStore(), store.deviceId == deviceId else { return nil }
        let role = self.normalizeRole(role)
        return store.tokens[role]
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = []) -> DeviceAuthEntry
    {
        let normalizedRole = self.normalizeRole(role)
        var next = self.readStore()
        if next?.deviceId != deviceId {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int(Date().timeIntervalSince1970 * 1000))
        if next == nil {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        next?.tokens[normalizedRole] = entry
        if let store = next {
            self.writeStore(store)
        }
        return entry
    }

    public static func clearToken(deviceId: String, role: String) {
        guard var store = readStore(), store.deviceId == deviceId else { return }
        let normalizedRole = self.normalizeRole(role)
        guard store.tokens[normalizedRole] != nil else { return }
        store.tokens.removeValue(forKey: normalizedRole)
        self.writeStore(store)
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

    private static func readStore() -> DeviceAuthStoreFile? {
        guard let data = OpenClawSQLiteKVStore.readJSONData(scope: self.stateScope, key: self.stateKey) else {
            return nil
        }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data) else {
            return nil
        }
        guard decoded.version == 1 else { return nil }
        return decoded
    }

    private static func writeStore(_ store: DeviceAuthStoreFile) {
        do {
            let data = try JSONEncoder().encode(store)
            try OpenClawSQLiteKVStore.writeJSONData(scope: self.stateScope, key: self.stateKey, data: data)
        } catch {
            // best-effort only
        }
    }
}
