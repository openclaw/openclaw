import Foundation

public struct DeviceAuthEntry: Codable, Sendable {
    public let token: String
    public let role: String
    public let scopes: [String]
    public let gatewayStableID: String?
    public let updatedAtMs: Int

    public init(
        token: String,
        role: String,
        scopes: [String],
        gatewayStableID: String? = nil,
        updatedAtMs: Int)
    {
        self.token = token
        self.role = role
        self.scopes = scopes
        self.gatewayStableID = gatewayStableID
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

    public static func loadToken(
        deviceId: String,
        role: String,
        gatewayStableID: String? = nil) -> DeviceAuthEntry?
    {
        guard let store = readStore(), store.deviceId == deviceId else { return nil }
        let normalizedRole = normalizeRole(role)
        let normalizedGatewayStableID = normalizeGatewayStableID(gatewayStableID)
        let key = tokenKey(role: normalizedRole, gatewayStableID: normalizedGatewayStableID)
        if let entry = store.tokens[key] {
            return entry
        }
        guard normalizedGatewayStableID == nil else { return nil }
        return legacyUnscopedEntry(store: store, role: normalizedRole)
    }

    public static func loadLegacyUnscopedToken(deviceId: String, role: String) -> DeviceAuthEntry? {
        guard let store = readStore(), store.deviceId == deviceId else { return nil }
        return legacyUnscopedEntry(store: store, role: normalizeRole(role))
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayStableID: String? = nil
    ) -> DeviceAuthEntry {
        let normalizedRole = normalizeRole(role)
        var next = readStore()
        if next?.deviceId != deviceId {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: normalizeScopes(scopes),
            gatewayStableID: normalizeGatewayStableID(gatewayStableID),
            updatedAtMs: Int(Date().timeIntervalSince1970 * 1000)
        )
        if next == nil {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let entryKey = tokenKey(
            role: normalizedRole,
            gatewayStableID: normalizeGatewayStableID(gatewayStableID))
        if entryKey != normalizedRole {
            next?.tokens.removeValue(forKey: normalizedRole)
        }
        next?.tokens[entryKey] = entry
        if let store = next {
            writeStore(store)
        }
        return entry
    }

    public static func clearToken(deviceId: String, role: String, gatewayStableID: String? = nil) {
        guard var store = readStore(), store.deviceId == deviceId else { return }
        let normalizedRole = normalizeRole(role)
        let key = tokenKey(
            role: normalizedRole,
            gatewayStableID: normalizeGatewayStableID(gatewayStableID))
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

    private static func normalizeGatewayStableID(_ gatewayStableID: String?) -> String? {
        let trimmed = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func tokenKey(role: String, gatewayStableID: String?) -> String {
        guard let gatewayStableID else { return role }
        return "\(role)@@\(gatewayStableID)"
    }

    private static func legacyUnscopedEntry(store: DeviceAuthStoreFile, role: String) -> DeviceAuthEntry? {
        guard let entry = store.tokens[role] else { return nil }
        return normalizeGatewayStableID(entry.gatewayStableID) == nil ? entry : nil
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
