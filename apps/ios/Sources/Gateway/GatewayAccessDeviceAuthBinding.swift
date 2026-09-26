import CryptoKit
import Foundation
import OpenClawKit

struct CloudflareAccessPrincipal: Equatable, Sendable {
    let fingerprint: String

    private init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    static func verified(from session: CloudflareAccessSession, now: Date = Date()) throws -> Self {
        try session.validate(now: now)
        return Self(fingerprint: GatewayAccessBindingDigest.make([
            "cloudflare-access-principal-v1",
            session.origin.url.absoluteString,
            session.issuer.absoluteString,
            session.audience,
            session.subject,
        ]))
    }
}

@MainActor
struct GatewayAccessDeviceAuthBindingStore {
    struct Persistence {
        var load: (String) -> String?
        var save: (String, String) -> Bool

        static var keychain: Self {
            let service = "\(Bundle.main.bundleIdentifier ?? "ai.openclaw.ios").gateway-access-device-auth"
            return Self(
                load: { GenericPasswordKeychainStore.loadString(service: service, account: $0) },
                save: { GenericPasswordKeychainStore.saveString($1, service: service, account: $0) })
        }
    }

    struct StoredDeviceAuth: Sendable {
        let deviceID: String
        let entry: DeviceAuthEntry
    }

    struct TokenVersion: Equatable, Sendable {
        fileprivate let tokenFingerprint: String
        fileprivate let updatedAtMs: Int64
    }

    private struct Binding: Codable {
        let version: Int
        let principalFingerprint: String
        let tokenFingerprint: String
    }

    static let shared = Self()

    private let persistence: Persistence
    private let loadDeviceAuth: (String, String, GatewayDeviceIdentityProfile) -> StoredDeviceAuth?

    init(
        persistence: Persistence = .keychain,
        loadDeviceAuth: ((String, String, GatewayDeviceIdentityProfile) -> StoredDeviceAuth?)? = nil)
    {
        self.persistence = persistence
        self.loadDeviceAuth = loadDeviceAuth ?? Self.loadPersistedDeviceAuth
    }

    func storedDeviceAuth(
        role: String,
        gatewayID: String?,
        profile: GatewayDeviceIdentityProfile) -> StoredDeviceAuth?
    {
        guard let gatewayID = Self.normalizedGatewayID(gatewayID) else { return nil }
        return self.loadDeviceAuth(role, gatewayID, profile)
    }

    private static func loadPersistedDeviceAuth(
        role: String,
        gatewayID: String,
        profile: GatewayDeviceIdentityProfile) -> StoredDeviceAuth?
    {
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: profile),
              let entry = DeviceAuthStore.loadToken(
                  deviceId: identity.deviceId,
                  role: role,
                  gatewayID: gatewayID,
                  profile: profile)
        else { return nil }
        return StoredDeviceAuth(deviceID: identity.deviceId, entry: entry)
    }

    func allowsStoredDeviceAuth(
        entry: StoredDeviceAuth?,
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile,
        fallbackAllowed: Bool) -> Bool
    {
        guard fallbackAllowed else { return false }
        guard let principal else { return true }
        guard let entry else { return false }
        return self.isBound(
            entry.entry.token,
            principal: principal,
            deviceID: entry.deviceID,
            gatewayID: gatewayID,
            role: role,
            profile: profile)
    }

    func authorizedScopes(
        entry: StoredDeviceAuth?,
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile) -> [String]
    {
        guard let entry,
              allowsStoredDeviceAuth(
                  entry: entry,
                  principal: principal,
                  gatewayID: gatewayID,
                  role: role,
                  profile: profile,
                  fallbackAllowed: true)
        else { return [] }
        return entry.entry.scopes
    }

    func tokenVersion(for entry: StoredDeviceAuth?) -> TokenVersion? {
        guard let entry else { return nil }
        return TokenVersion(
            tokenFingerprint: GatewayAccessBindingDigest.make(["gateway-device-auth-token-v1", entry.entry.token]),
            updatedAtMs: entry.entry.updatedAtMs)
    }

    func currentTokenVersion(
        role: String,
        gatewayID: String?,
        profile: GatewayDeviceIdentityProfile) -> TokenVersion?
    {
        self.tokenVersion(for: self.storedDeviceAuth(role: role, gatewayID: gatewayID, profile: profile))
    }

    @discardableResult
    func bindCurrentTokenAfterHandshake(
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile,
        previousVersion: TokenVersion?) -> Bool
    {
        guard let principal else { return true }
        guard let current = storedDeviceAuth(role: role, gatewayID: gatewayID, profile: profile),
              let currentVersion = tokenVersion(for: current),
              currentVersion != previousVersion
        else { return false }
        return self.bind(
            current.entry.token,
            principal: principal,
            deviceID: current.deviceID,
            gatewayID: gatewayID,
            role: role,
            profile: profile)
    }

    @discardableResult
    func bindGatewayIssuedToken(
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile,
        persistedRoles: Set<String>) -> Bool
    {
        guard let principal else { return true }
        guard persistedRoles.contains(role),
              let current = storedDeviceAuth(role: role, gatewayID: gatewayID, profile: profile)
        else { return false }
        return self.bind(
            current.entry.token,
            principal: principal,
            deviceID: current.deviceID,
            gatewayID: gatewayID,
            role: role,
            profile: profile)
    }

    @discardableResult
    func bind(
        _ token: String,
        principal: CloudflareAccessPrincipal,
        deviceID: String,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile) -> Bool
    {
        guard !token.isEmpty,
              let account = Self.account(deviceID: deviceID, gatewayID: gatewayID, role: role, profile: profile)
        else { return false }
        let binding = Binding(
            version: 1,
            principalFingerprint: principal.fingerprint,
            tokenFingerprint: GatewayAccessBindingDigest.make(["gateway-device-auth-token-v1", token]))
        guard let data = try? JSONEncoder().encode(binding),
              let value = String(data: data, encoding: .utf8)
        else { return false }
        return self.persistence.save(account, value)
    }

    private func isBound(
        _ token: String,
        principal: CloudflareAccessPrincipal,
        deviceID: String,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile) -> Bool
    {
        guard let account = Self.account(deviceID: deviceID, gatewayID: gatewayID, role: role, profile: profile),
              let value = persistence.load(account),
              let data = value.data(using: .utf8),
              let binding = try? JSONDecoder().decode(Binding.self, from: data)
        else { return false }
        return binding.version == 1 &&
            binding.principalFingerprint == principal.fingerprint &&
            binding.tokenFingerprint == GatewayAccessBindingDigest.make(["gateway-device-auth-token-v1", token])
    }

    private static func normalizedGatewayID(_ gatewayID: String?) -> String? {
        guard let gatewayID = gatewayID?.trimmingCharacters(in: .whitespacesAndNewlines),
              !gatewayID.isEmpty
        else { return nil }
        return gatewayID
    }

    private static func account(
        deviceID: String,
        gatewayID: String?,
        role: String,
        profile: GatewayDeviceIdentityProfile) -> String?
    {
        guard !deviceID.isEmpty,
              let gatewayID = normalizedGatewayID(gatewayID),
              !role.isEmpty
        else { return nil }
        let digest = GatewayAccessBindingDigest.make([
            "gateway-device-auth-binding-slot-v1",
            profile.rawValue,
            deviceID,
            gatewayID,
            role,
        ])
        return "binding-v1.\(digest)"
    }
}

private enum GatewayAccessBindingDigest {
    static func make(_ components: [String]) -> String {
        var input = Data()
        for component in components {
            let bytes = Data(component.utf8)
            var length = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { input.append(contentsOf: $0) }
            input.append(bytes)
        }
        return SHA256.hash(data: input).map { String(format: "%02x", Int($0)) }.joined()
    }
}
