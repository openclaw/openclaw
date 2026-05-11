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

public enum DeviceAuthStore {
    public static func loadToken(deviceId: String, role: String) -> DeviceAuthEntry? {
        let role = self.normalizeRole(role)
        guard let row = OpenClawSQLiteStateStore.readDeviceAuthToken(deviceId: deviceId, role: role)
        else { return nil }
        return self.entry(from: row)
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = []) -> DeviceAuthEntry
    {
        let normalizedRole = self.normalizeRole(role)
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int(Date().timeIntervalSince1970 * 1000))
        do {
            if let currentDeviceId = OpenClawSQLiteStateStore.readLatestDeviceAuthDeviceId(),
               currentDeviceId != deviceId
            {
                try OpenClawSQLiteStateStore.deleteAllDeviceAuthTokens()
            }
            try OpenClawSQLiteStateStore.upsertDeviceAuthToken(self.row(deviceId: deviceId, entry: entry))
        } catch {
            // best-effort only
        }
        return entry
    }

    public static func clearToken(deviceId: String, role: String) {
        let normalizedRole = self.normalizeRole(role)
        try? OpenClawSQLiteStateStore.deleteDeviceAuthToken(deviceId: deviceId, role: normalizedRole)
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

    private static func entry(from row: OpenClawSQLiteDeviceAuthTokenRow) -> DeviceAuthEntry {
        DeviceAuthEntry(
            token: row.token,
            role: row.role,
            scopes: self.decodeScopes(row.scopesJSON),
            updatedAtMs: row.updatedAtMs)
    }

    private static func row(deviceId: String, entry: DeviceAuthEntry) -> OpenClawSQLiteDeviceAuthTokenRow {
        OpenClawSQLiteDeviceAuthTokenRow(
            deviceId: deviceId,
            role: entry.role,
            token: entry.token,
            scopesJSON: self.encodeScopes(entry.scopes),
            updatedAtMs: entry.updatedAtMs)
    }

    private static func encodeScopes(_ scopes: [String]) -> String {
        guard let data = try? JSONEncoder().encode(scopes),
              let raw = String(data: data, encoding: .utf8)
        else { return "[]" }
        return raw
    }

    private static func decodeScopes(_ raw: String) -> [String] {
        guard let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return decoded
    }
}
