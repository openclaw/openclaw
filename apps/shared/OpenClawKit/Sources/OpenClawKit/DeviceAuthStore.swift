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
    public static func loadToken(
        deviceId: String,
        role: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry?
    {
        guard let store = readStore(profile: profile), store.deviceId == deviceId else { return nil }
        let role = self.normalizeRole(role)
        return store.tokens[role]
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry
    {
        let normalizedRole = self.normalizeRole(role)
        var next = self.readStore(profile: profile)
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
            self.writeStore(store, profile: profile)
        }
        return entry
    }

    public static func clearToken(
        deviceId: String,
        role: String,
        profile: GatewayDeviceIdentityProfile = .primary)
    {
        guard var store = readStore(profile: profile), store.deviceId == deviceId else { return }
        let normalizedRole = self.normalizeRole(role)
        guard store.tokens[normalizedRole] != nil else { return }
        store.tokens.removeValue(forKey: normalizedRole)
        self.writeStore(store, profile: profile)
    }

    public static func clearAll(profile: GatewayDeviceIdentityProfile = .primary) {
        try? FileManager.default.removeItem(at: self.fileURL(profile: profile))
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

    private static func fileURL(profile: GatewayDeviceIdentityProfile) -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.authFileName, isDirectory: false)
    }

    private static func readStore(profile: GatewayDeviceIdentityProfile) -> DeviceAuthStoreFile? {
        let url = self.fileURL(profile: profile)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data) else {
            return nil
        }
        guard decoded.version == 1 else { return nil }
        return decoded
    }

    private static func writeStore(_ store: DeviceAuthStoreFile, profile: GatewayDeviceIdentityProfile) {
        let url = self.fileURL(profile: profile)
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
