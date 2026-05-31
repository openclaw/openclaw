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
    private static let legacyFileName = "device-auth.json"
    private static let androidSecurePrefsTokenMarker = "__openclaw_secure_prefs__"

    public static func loadToken(deviceId: String, role: String) -> DeviceAuthEntry? {
        let role = self.normalizeRole(role)
        guard let row = OpenClawSQLiteStateStore.readDeviceAuthToken(deviceId: deviceId, role: role)
        else { return self.loadLegacyTokenIfNoSQLiteAuthRows(deviceId: deviceId, role: role) }
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
        let currentDeviceId = OpenClawSQLiteStateStore.readLatestDeviceAuthDeviceId()
        let legacyStoreToImport =
            currentDeviceId == nil ? self.readLegacyStore().flatMap { $0.deviceId == deviceId ? $0 : nil } : nil
        let sqliteDeviceChanged = currentDeviceId != nil && currentDeviceId != deviceId
        let shouldDropLegacyStore =
            sqliteDeviceChanged || self.readLegacyStore().map { $0.deviceId != deviceId } == true
        do {
            if sqliteDeviceChanged {
                try OpenClawSQLiteStateStore.deleteAllDeviceAuthTokens()
            }
            if let legacyStoreToImport {
                for legacyEntry in legacyStoreToImport.tokens.values {
                    let normalized = self.normalizedLegacyEntry(legacyEntry)
                    try OpenClawSQLiteStateStore.upsertDeviceAuthToken(
                        self.row(deviceId: deviceId, entry: normalized))
                }
            }
            try OpenClawSQLiteStateStore.upsertDeviceAuthToken(self.row(deviceId: deviceId, entry: entry))
            if shouldDropLegacyStore || legacyStoreToImport != nil {
                self.removeLegacyStore()
            } else {
                self.removeLegacyToken(deviceId: deviceId, role: normalizedRole)
            }
        } catch {
            var fallback =
                self.readLegacyStore().flatMap { $0.deviceId == deviceId ? $0 : nil }
                    ?? DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
            fallback.tokens[normalizedRole] = entry
            self.writeLegacyStore(fallback)
        }
        return entry
    }

    public static func clearToken(deviceId: String, role: String) {
        let normalizedRole = self.normalizeRole(role)
        try? OpenClawSQLiteStateStore.deleteDeviceAuthToken(deviceId: deviceId, role: normalizedRole)
        self.removeLegacyToken(deviceId: deviceId, role: normalizedRole)
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

    private static func entry(from row: OpenClawSQLiteDeviceAuthTokenRow) -> DeviceAuthEntry? {
        guard row.token != self.androidSecurePrefsTokenMarker else { return nil }
        return DeviceAuthEntry(
            token: row.token,
            role: row.role,
            scopes: self.decodeScopes(row.scopesJSON),
            updatedAtMs: row.updatedAtMs)
    }

    private static func normalizedLegacyEntry(_ entry: DeviceAuthEntry) -> DeviceAuthEntry {
        DeviceAuthEntry(
            token: entry.token,
            role: self.normalizeRole(entry.role),
            scopes: self.normalizeScopes(entry.scopes),
            updatedAtMs: entry.updatedAtMs)
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

    private static func loadLegacyTokenIfNoSQLiteAuthRows(deviceId: String, role: String) -> DeviceAuthEntry? {
        guard OpenClawSQLiteStateStore.readLatestDeviceAuthDeviceId() == nil else {
            self.removeLegacyToken(deviceId: deviceId, role: role)
            return nil
        }
        return self.importLegacyTokenIfNeeded(deviceId: deviceId, role: role)
    }

    private static func legacyFileURL() -> URL {
        DeviceIdentityPaths.legacyStateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(self.legacyFileName, isDirectory: false)
    }

    private static func readLegacyStore() -> DeviceAuthStoreFile? {
        let url = self.legacyFileURL()
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data),
              decoded.version == 1
        else { return nil }
        return decoded
    }

    private static func writeLegacyStore(_ store: DeviceAuthStoreFile) {
        let url = self.legacyFileURL()
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

    private static func importLegacyTokenIfNeeded(deviceId: String, role: String) -> DeviceAuthEntry? {
        guard let store = self.readLegacyStore(), store.deviceId == deviceId else { return nil }
        do {
            for entry in store.tokens.values {
                let normalized = self.normalizedLegacyEntry(entry)
                try OpenClawSQLiteStateStore.upsertDeviceAuthToken(self.row(deviceId: deviceId, entry: normalized))
            }
            try FileManager.default.removeItem(at: self.legacyFileURL())
        } catch {
            return store.tokens[role].map(self.normalizedLegacyEntry)
        }
        guard let row = OpenClawSQLiteStateStore.readDeviceAuthToken(deviceId: deviceId, role: role) else {
            return nil
        }
        return self.entry(from: row)
    }

    private static func removeLegacyToken(deviceId: String, role: String) {
        guard var store = self.readLegacyStore(), store.deviceId == deviceId else { return }
        store.tokens.removeValue(forKey: role)
        if store.tokens.isEmpty {
            self.removeLegacyStore()
        } else {
            self.writeLegacyStore(store)
        }
    }

    private static func removeLegacyStore() {
        try? FileManager.default.removeItem(at: self.legacyFileURL())
    }
}
