import CryptoKit
import Foundation
import Security
import Synchronization

public struct GatewayTLSParams: Equatable, Sendable {
    public let required: Bool
    public let expectedFingerprint: String?
    public let allowTOFU: Bool
    public let storeKey: String?

    public init(required: Bool, expectedFingerprint: String?, allowTOFU: Bool, storeKey: String?) {
        self.required = required
        self.expectedFingerprint = expectedFingerprint
        self.allowTOFU = allowTOFU
        self.storeKey = storeKey
    }
}

public enum GatewayTLSValidationFailureKind: String, Sendable {
    case pinMismatch
    case certificateUnavailable
    case untrustedCertificate
    case pinStorageUnavailable
    case authorityMismatch
}

public struct GatewayTLSValidationFailure: Equatable, Sendable {
    public let kind: GatewayTLSValidationFailureKind
    public let host: String
    public let storeKey: String?
    public let expectedFingerprint: String?
    public let observedFingerprint: String?
    public let systemTrustOk: Bool
    public let port: Int?

    public init(
        kind: GatewayTLSValidationFailureKind,
        host: String,
        storeKey: String?,
        expectedFingerprint: String?,
        observedFingerprint: String?,
        systemTrustOk: Bool,
        port: Int? = nil)
    {
        self.kind = kind
        self.host = host
        self.storeKey = storeKey
        self.expectedFingerprint = expectedFingerprint
        self.observedFingerprint = observedFingerprint
        self.systemTrustOk = systemTrustOk
        self.port = port
    }
}

public struct GatewayTLSValidationError: LocalizedError, Sendable {
    public let failure: GatewayTLSValidationFailure
    public let context: String

    public init(failure: GatewayTLSValidationFailure, context: String) {
        self.failure = failure
        self.context = context
    }

    public var errorDescription: String? {
        let prefix = self.context.trimmingCharacters(in: .whitespacesAndNewlines)
        switch self.failure.kind {
        case .pinMismatch:
            let expected = self.failure.expectedFingerprint ?? "unknown"
            let observed = self.failure.observedFingerprint ?? "unknown"
            let mismatch = "expected \(expected), observed \(observed)"
            return "\(prefix): TLS certificate pin mismatch for \(self.failure.host) (\(mismatch))"
        case .certificateUnavailable:
            return "\(prefix): TLS certificate unavailable for \(self.failure.host)"
        case .untrustedCertificate:
            return "\(prefix): TLS certificate is not trusted for \(self.failure.host)"
        case .pinStorageUnavailable:
            return "\(prefix): TLS certificate pin could not be saved for \(self.failure.host)"
        case .authorityMismatch:
            return "\(prefix): TLS authority does not match the requested gateway for \(self.failure.host)"
        }
    }
}

public enum GatewayBoundedDataError: Error, Equatable, Sendable {
    case responseTooLarge(maximumBytes: Int)
}

// periphery:ignore - Native session adapters expose typed TLS repair evidence to GatewayChannel.
public protocol GatewayTLSFailureProviding: AnyObject {
    // periphery:ignore - The shared channel consumes this through the optional provider seam.
    func consumeLastTLSFailure() -> GatewayTLSValidationFailure?
}

extension GatewayTLSFailureProviding {
    func consumeHTTPFailure(_ error: Error) -> Error {
        // The delegate's diagnostic belongs to this attempt, including cancellation.
        // Consume it once so a later request cannot inherit an earlier trust failure.
        let failure = self.consumeLastTLSFailure()
        guard !Task.isCancelled, error is URLError, let failure else { return error }
        return GatewayTLSValidationError(failure: failure, context: "gateway request")
    }
}

// periphery:ignore - Native session adapters declare whether their TLS path permits token retry.
public protocol GatewayDeviceTokenRetryTrustProviding: AnyObject {
    // periphery:ignore - The shared channel consumes this through the optional provider seam.
    var allowsDeviceTokenRetryAuth: Bool { get }
}

enum GatewayTLSChallengeDecision: Equatable {
    case accept(fingerprint: String?, enforcePin: Bool, saveFirstUse: Bool)
    case reject(GatewayTLSValidationFailureKind)
}

enum GatewayTLSValidationPolicy {
    static func decide(
        expectedFingerprint: String?,
        observedFingerprint: String?,
        allowTOFU: Bool,
        required: Bool,
        systemTrustOk: Bool) -> GatewayTLSChallengeDecision
    {
        if let expectedFingerprint {
            guard let observedFingerprint else {
                return .reject(.certificateUnavailable)
            }
            return observedFingerprint == expectedFingerprint
                ? .accept(fingerprint: observedFingerprint, enforcePin: true, saveFirstUse: false)
                : .reject(.pinMismatch)
        }
        if allowTOFU,
           let observedFingerprint,
           systemTrustOk
        {
            return .accept(fingerprint: observedFingerprint, enforcePin: true, saveFirstUse: true)
        }
        if allowTOFU, required {
            return .reject(observedFingerprint == nil ? .certificateUnavailable : .untrustedCertificate)
        }
        if systemTrustOk || !required {
            return .accept(fingerprint: observedFingerprint, enforcePin: false, saveFirstUse: false)
        }
        return .reject(observedFingerprint == nil ? .certificateUnavailable : .untrustedCertificate)
    }
}

public enum GatewayTLSServerTrustDecision: Equatable, Sendable {
    case accept
    case reject
}

enum GatewayTLSServerTrustEvaluation {
    case accept(fingerprint: String?, enforcePin: Bool)
    case reject(failure: GatewayTLSValidationFailure, enforcedFingerprint: String?)
}

public enum GatewayTLSServerTrust {
    public static func evaluate(
        trust: SecTrust,
        host: String,
        port: Int,
        params: GatewayTLSParams) -> GatewayTLSServerTrustDecision
    {
        let expectedFingerprint = params.expectedFingerprint ?? params.storeKey.flatMap {
            GatewayTLSStore.loadFingerprint(stableID: $0)
        }
        return switch self.evaluate(
            trust: trust,
            host: host,
            port: port,
            params: params,
            expectedFingerprint: expectedFingerprint)
        {
        case .accept:
            .accept
        case .reject:
            .reject
        }
    }

    static func evaluate(
        trust: SecTrust,
        host: String,
        port: Int,
        params: GatewayTLSParams,
        expectedFingerprint: String?) -> GatewayTLSServerTrustEvaluation
    {
        let hostnamePolicy = SecPolicyCreateSSL(true, host as CFString)
        let systemTrustOk =
            SecTrustSetPolicies(trust, hostnamePolicy) == errSecSuccess &&
            SecTrustEvaluateWithError(trust, nil)
        let fingerprint = certificateFingerprint(trust)
        let expected = expectedFingerprint.map(normalizeFingerprint)
        let failure: (GatewayTLSValidationFailureKind, String?, String?) -> GatewayTLSServerTrustEvaluation
        failure = { kind, expectedFingerprint, enforcedFingerprint in
            .reject(
                failure: GatewayTLSValidationFailure(
                    kind: kind,
                    host: host,
                    storeKey: params.storeKey,
                    expectedFingerprint: expectedFingerprint,
                    observedFingerprint: fingerprint,
                    systemTrustOk: systemTrustOk,
                    port: port),
                enforcedFingerprint: enforcedFingerprint)
        }
        switch GatewayTLSValidationPolicy.decide(
            expectedFingerprint: expected,
            observedFingerprint: fingerprint,
            allowTOFU: params.allowTOFU,
            required: params.required,
            systemTrustOk: systemTrustOk)
        {
        case let .accept(acceptedFingerprint, enforcePin, saveFirstUse):
            guard saveFirstUse else {
                return .accept(fingerprint: acceptedFingerprint, enforcePin: enforcePin)
            }
            guard let acceptedFingerprint,
                  let storeKey = params.storeKey,
                  let claimedFingerprint = GatewayTLSStore.claimFirstUseFingerprint(
                      acceptedFingerprint,
                      stableID: storeKey)
            else {
                return failure(.pinStorageUnavailable, nil, nil)
            }
            guard claimedFingerprint == acceptedFingerprint else {
                return failure(.pinMismatch, claimedFingerprint, claimedFingerprint)
            }
            return .accept(fingerprint: acceptedFingerprint, enforcePin: enforcePin)
        case let .reject(kind):
            return failure(kind, expected, nil)
        }
    }
}

struct GatewayTLSKeychainOperations: @unchecked Sendable {
    let copyMatching: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    let add: (CFDictionary) -> OSStatus
    let update: (CFDictionary, CFDictionary) -> OSStatus
    let delete: (CFDictionary) -> OSStatus

    static let live = GatewayTLSKeychainOperations(
        copyMatching: { SecItemCopyMatching($0, $1) },
        add: { SecItemAdd($0, nil) },
        update: { SecItemUpdate($0, $1) },
        delete: { SecItemDelete($0) })
}

struct GatewayTLSKeychainNamespaceState {
    private(set) var suffix: String?
    private(set) var used = false

    mutating func configure(suffix: String) -> Bool {
        if let configured = self.suffix {
            return configured == suffix
        }
        guard !self.used || suffix.isEmpty else { return false }
        self.suffix = suffix
        return true
    }

    mutating func service(base: String) -> String {
        self.used = true
        return base + (self.suffix ?? "")
    }
}

public enum GatewayTLSStore {
    @TaskLocal static var keychainOperations = GatewayTLSKeychainOperations.live

    private enum FingerprintRead {
        case missing
        case value(String)
        case unavailable
    }

    private static let baseKeychainService = "ai.openclaw.tls-pinning"
    private static let keychainNamespace = Mutex(GatewayTLSKeychainNamespaceState())
    private static var keychainService: String {
        self.keychainNamespace.withLock { $0.service(base: self.baseKeychainService) }
    }

    private static let keychainAccountPrefix = "fingerprint.v3."
    private static let legacyCanonicalAccountPrefix = "fingerprint.v2."
    private static let firstUseClaims = Mutex<[String: String]>([:])

    /// The macOS app profile is immutable for the process lifetime. Configure its
    /// Keychain namespace before constructing any Gateway connection.
    @discardableResult
    public static func configureKeychainServiceSuffix(_ suffix: String) -> Bool {
        self.keychainNamespace.withLock { $0.configure(suffix: suffix) }
    }

    static func resolvedKeychainService(suffix: String) -> String {
        self.baseKeychainService + suffix
    }

    public static func loadFingerprint(stableID: String) -> String? {
        guard case let .value(fingerprint) = self.loadFingerprintResult(stableID: stableID) else {
            return nil
        }
        return fingerprint
    }

    public static func saveFingerprint(_ value: String, stableID: String) {
        guard self.writeCanonicalFingerprint(value, stableID: stableID) else { return }
        _ = self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    static func claimFirstUseFingerprint(_ value: String, stableID: String) -> String? {
        guard let account = self.keychainAccount(stableID: stableID) else { return nil }
        switch self.loadFingerprintResult(stableID: stableID) {
        case let .value(existing):
            self.firstUseClaims.withLock { $0[stableID] = existing }
            return existing
        case .unavailable:
            return nil
        case .missing:
            break
        }

        let claimed = self.createCanonicalFingerprintIfAbsent(value, account: account)
        if claimed != nil {
            _ = self.clearSafeLegacyFingerprint(stableID: stableID)
        }
        if let claimed {
            self.firstUseClaims.withLock { $0[stableID] = claimed }
        }
        return claimed
    }

    public static func claimedFirstUseFingerprint(stableID: String) -> String? {
        self.firstUseClaims.withLock { $0[stableID] }
    }

    @discardableResult
    public static func replaceFingerprint(_ value: String, stableID: String) -> Bool {
        guard self.writeCanonicalFingerprint(value, stableID: stableID) else { return false }
        return self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func replaceFingerprint(
        _ value: String,
        ifCurrent expectedValue: String,
        stableID: String) -> Bool
    {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let expectedData = Data(self.canonicalStoredFingerprint(expectedValue).utf8)
        let replacementData = Data(self.canonicalStoredFingerprint(value).utf8)
        var query = self.fingerprintQuery(account: account)
        query[kSecAttrGeneric as String] = expectedData
        let updates: [String: Any] = [
            kSecValueData as String: replacementData,
            kSecAttrGeneric as String: replacementData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        guard self.keychainOperations.update(query as CFDictionary, updates as CFDictionary) == errSecSuccess else {
            return false
        }
        return self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func clearFingerprint(stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let removedCanonical = self.deleteFingerprint(account: account)
        let removedLegacy = self.clearSafeLegacyFingerprint(stableID: stableID)
        let removed = removedCanonical && removedLegacy
        if removed {
            self.firstUseClaims.withLock { $0[stableID] = nil }
        }
        return removed
    }

    @discardableResult
    public static func clearAllFingerprints() -> Bool {
        let removedKeychain = self.keychainOperations.delete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
        ] as CFDictionary)
        let removed = removedKeychain == errSecSuccess || removedKeychain == errSecItemNotFound
        if removed {
            self.firstUseClaims.withLock { $0.removeAll() }
        }
        return removed
    }

    // MARK: - Migration

    /// v3 stores the canonical fingerprint in both value data and a searchable
    /// comparison attribute. Older records migrate by atomically creating v3;
    /// concurrent writers always keep the first complete v3 record.
    private static func loadFingerprintResult(stableID: String) -> FingerprintRead {
        guard let account = self.keychainAccount(stableID: stableID) else { return .unavailable }
        switch self.readCanonicalFingerprint(account: account) {
        case let .value(fingerprint):
            _ = self.clearSafeLegacyFingerprint(stableID: stableID)
            return .value(fingerprint)
        case .unavailable:
            return .unavailable
        case .missing:
            return self.migrateLegacyFingerprint(stableID: stableID, account: account)
        }
    }

    private static func migrateLegacyFingerprint(
        stableID: String,
        account: String) -> FingerprintRead
    {
        let accounts = [
            self.keychainAccount(stableID: stableID, prefix: self.legacyCanonicalAccountPrefix),
            self.canSafelyReadLegacyRawStorageKey(stableID) ? stableID : nil,
        ].compactMap(\.self)
        for legacyAccount in accounts {
            switch self.readLegacyKeychainFingerprint(account: legacyAccount) {
            case let .value(fingerprint):
                guard let winner = self.createCanonicalFingerprintIfAbsent(fingerprint, account: account) else {
                    return .unavailable
                }
                _ = self.clearSafeLegacyFingerprint(stableID: stableID)
                return .value(winner)
            case .unavailable:
                return .unavailable
            case .missing:
                break
            }
        }
        return .missing
    }

    private static func readCanonicalFingerprint(account: String) -> FingerprintRead {
        var query = self.fingerprintQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = self.keychainOperations.copyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return .missing
        }
        guard status == errSecSuccess,
              let item = result as? [String: Any],
              let data = item[kSecValueData as String] as? Data,
              let comparisonData = item[kSecAttrGeneric as String] as? Data,
              let value = String(data: data, encoding: .utf8),
              let comparison = String(data: comparisonData, encoding: .utf8)
        else { return .unavailable }
        let fingerprint = self.canonicalStoredFingerprint(value)
        return comparison == fingerprint ? .value(fingerprint) : .unavailable
    }

    private static func readLegacyKeychainFingerprint(account: String) -> FingerprintRead {
        var query = self.fingerprintQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = self.keychainOperations.copyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return .missing
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              let fingerprint = value.trimmedNonEmpty
        else { return .unavailable }
        return .value(fingerprint)
    }

    private static func writeCanonicalFingerprint(_ value: String, stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let data = Data(self.canonicalStoredFingerprint(value).utf8)
        let query = self.fingerprintQuery(account: account)
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrGeneric as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = self.keychainOperations.update(query as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else { return false }
        return self.createCanonicalFingerprintIfAbsent(value, account: account) != nil
    }

    private static func createCanonicalFingerprintIfAbsent(
        _ value: String,
        account: String) -> String?
    {
        let fingerprint = self.canonicalStoredFingerprint(value)
        let data = Data(fingerprint.utf8)
        var insert = self.fingerprintQuery(account: account)
        insert[kSecValueData as String] = data
        insert[kSecAttrGeneric as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = self.keychainOperations.add(insert as CFDictionary)
        if addStatus == errSecSuccess {
            return fingerprint
        }
        guard addStatus == errSecDuplicateItem else { return nil }
        guard case let .value(fingerprint) = self.readCanonicalFingerprint(account: account) else { return nil }
        return fingerprint
    }

    private static func keychainAccount(
        stableID: String,
        prefix: String = GatewayTLSStore.keychainAccountPrefix) -> String?
    {
        guard !stableID.isEmpty else { return nil }
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return prefix + component
    }

    private static func canSafelyReadLegacyRawStorageKey(_ stableID: String) -> Bool {
        !stableID.isEmpty &&
            !stableID.hasPrefix(self.keychainAccountPrefix) &&
            !stableID.hasPrefix(self.legacyCanonicalAccountPrefix) &&
            stableID.unicodeScalars.allSatisfy(\.isASCII)
    }

    private static func canonicalStoredFingerprint(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = normalizeFingerprint(trimmed)
        return normalized.count == 64 ? normalized : trimmed
    }

    @discardableResult
    private static func clearSafeLegacyFingerprint(stableID: String) -> Bool {
        let removedV2 = self.keychainAccount(
            stableID: stableID,
            prefix: self.legacyCanonicalAccountPrefix).map {
            self.deleteFingerprint(account: $0)
        } ?? true
        guard self.canSafelyReadLegacyRawStorageKey(stableID) else { return removedV2 }
        let removedRaw = self.deleteFingerprint(account: stableID)
        return removedRaw && removedV2
    }

    private static func fingerprintQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
        ]
    }

    private static func deleteFingerprint(account: String) -> Bool {
        let query = self.fingerprintQuery(account: account)
        let status = self.keychainOperations.delete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

public protocol GatewayTLSRouteMetadataProviding: AnyObject {
    var effectiveTLSFingerprintSHA256: String? { get }
}

public struct GatewayTLSAuthority: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int
    private let defaultPort: Int

    public init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              let defaultPort = Self.defaultPort(for: scheme),
              let host = Self.normalizedHost(url.host)
        else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = url.port ?? defaultPort
        self.defaultPort = defaultPort
    }

    public func matches(host: String, port: Int) -> Bool {
        // URLProtectionSpace uses 0 for the protocol's default port. Normalize it here so
        // every pinned Apple transport reaches the same authority decision.
        let challengePort = port == 0 ? self.defaultPort : port
        return Self.normalizedHost(host) == self.host && challengePort == self.port
    }

    public var serialized: String {
        let hostPart = self.host.contains(":") ? "[\(self.host)]" : self.host
        return "\(self.scheme)://\(hostPart)" + (self.port == self.defaultPort ? "" : ":\(self.port)")
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "http", "ws": 80
        case "https", "wss": 443
        default: nil
        }
    }

    private static func normalizedHost(_ host: String?) -> String? {
        let value = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !value.isEmpty else { return nil }
        return value.hasPrefix("[") && value.hasSuffix("]")
            ? String(value.dropFirst().dropLast())
            : value
    }
}

struct GatewayTLSPinningState {
    private(set) var acceptedFingerprint: String?
    private(set) var enforcedFingerprint: String?

    init(expectedFingerprint: String?) {
        let expected = expectedFingerprint.map(normalizeFingerprint)
        self.enforcedFingerprint = expected
        self.acceptedFingerprint = expected.flatMap { $0.count == 64 ? $0 : nil }
    }

    mutating func enforceFingerprint(_ fingerprint: String) {
        self.enforcedFingerprint = fingerprint
    }

    mutating func recordAcceptance(_ fingerprint: String?, enforcePin: Bool) {
        guard let fingerprint else { return }
        self.acceptedFingerprint = fingerprint
        if enforcePin {
            self.enforcedFingerprint = fingerprint
        }
    }
}

public final class GatewayTLSPinningSession: NSObject, WebSocketSessioning, URLSessionTaskDelegate,
    GatewayTLSFailureProviding, GatewayDeviceTokenRetryTrustProviding, GatewayTLSRouteMetadataProviding,
    @unchecked Sendable
{
    private let params: GatewayTLSParams
    private let allowsRedirects: Bool
    private let allowsStoredCredentials: Bool
    private let failureLock = NSLock()
    private var lastTLSFailure: GatewayTLSValidationFailure?
    private var pinningState: GatewayTLSPinningState
    private var expectedAuthority: GatewayTLSAuthority?
    private lazy var session: URLSession = {
        let config = self.allowsStoredCredentials ? URLSessionConfiguration.default : .ephemeral
        if !self.allowsStoredCredentials {
            // Explicit per-request authority cannot inherit or persist another
            // account's cookies, HTTP credentials, or authenticated cache entries.
            config.httpShouldSetCookies = false
            config.httpCookieStorage = nil
            config.urlCredentialStorage = nil
            config.urlCache = nil
        }
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public init(
        params: GatewayTLSParams,
        allowsRedirects: Bool = true,
        allowsStoredCredentials: Bool = true)
    {
        self.params = params
        self.allowsRedirects = allowsRedirects
        self.allowsStoredCredentials = allowsStoredCredentials
        self.pinningState = GatewayTLSPinningState(expectedFingerprint: params.expectedFingerprint)
        super.init()
    }

    public var allowsDeviceTokenRetryAuth: Bool {
        self.failureLock.withLock { self.pinningState.enforcedFingerprint != nil }
    }

    public var effectiveTLSFingerprintSHA256: String? {
        self.failureLock.withLock { self.pinningState.acceptedFingerprint }
    }

    public func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
        self.failureLock.withLock {
            defer { self.lastTLSFailure = nil }
            return self.lastTLSFailure
        }
    }

    // periphery:ignore - External TLS transports delegate trust ownership to this session.
    /// Approve the certificate from an externally hosted TLS stream before it sends HTTP headers.
    /// The existing pin owner also supplies typed repair evidence and first-use persistence.
    public func validateServerTrust(_ trust: SecTrust, for url: URL) -> Bool {
        guard let authority = GatewayTLSAuthority(url: url), authority.scheme == "wss" else { return false }
        return self.evaluateServerTrust(
            trust,
            host: authority.host,
            port: authority.port,
            expectedFingerprint: self.currentEnforcedFingerprint())
    }

    private func evaluateServerTrust(
        _ trust: SecTrust,
        host: String,
        port: Int,
        expectedFingerprint: String?) -> Bool
    {
        switch GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: host,
            port: port,
            params: self.params,
            expectedFingerprint: expectedFingerprint)
        {
        case let .accept(fingerprint, enforcePin):
            self.failureLock.withLock {
                self.lastTLSFailure = nil
                self.pinningState.recordAcceptance(fingerprint, enforcePin: enforcePin)
            }
            return true
        case let .reject(failure, enforcedFingerprint):
            if let enforcedFingerprint {
                self.failureLock.withLock { self.pinningState.enforceFingerprint(enforcedFingerprint) }
            }
            self.recordTLSFailure(failure)
            return false
        }
    }

    private func recordTLSFailure(_ failure: GatewayTLSValidationFailure) {
        self.failureLock.withLock { self.lastTLSFailure = failure }
    }

    private func currentEnforcedFingerprint() -> String? {
        self.failureLock.withLock { self.pinningState.enforcedFingerprint }
    }

    private func registerExpectedAuthority(url: URL?) {
        guard let url, let authority = GatewayTLSAuthority(url: url) else { return }
        self.failureLock.withLock {
            if self.expectedAuthority == nil {
                self.expectedAuthority = authority
            }
        }
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.registerExpectedAuthority(url: request.url)
        let task = self.session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
        return WebSocketTaskBox(task: task)
    }

    // periphery:ignore - Public response-only probe for app-owned ingress authorization.
    /// Read headers without buffering a response body, while retaining the route's TLS policy.
    public func response(for request: URLRequest) async throws -> URLResponse {
        self.registerExpectedAuthority(url: request.url)
        try Task.checkCancellation()
        let delegate = GatewayHTTPResponseDelegate(owner: self)
        let task = self.session.dataTask(with: request)
        // Task delegates forward unimplemented authentication callbacks to the session owner.
        task.delegate = delegate
        defer { task.cancel() }
        do {
            return try await withTaskCancellationHandler {
                try Task.checkCancellation()
                task.resume()
                var responses = delegate.responses.stream.makeAsyncIterator()
                guard let response = try await responses.next() else { throw CancellationError() }
                try Task.checkCancellation()
                return response
            } onCancel: {
                task.cancel()
            }
        } catch {
            throw self.consumeHTTPFailure(error)
        }
    }

    public func data(
        for request: URLRequest,
        maximumBytes: Int,
        isCurrent: @Sendable () -> Bool = { true }) async throws -> (Data, URLResponse)
    {
        self.registerExpectedAuthority(url: request.url)
        guard maximumBytes >= 0 else {
            throw GatewayBoundedDataError.responseTooLarge(maximumBytes: maximumBytes)
        }

        try Task.checkCancellation()
        guard isCurrent() else { throw CancellationError() }
        try Task.checkCancellation()
        let (bytes, response) = try await self.bytes(for: request)
        let expectedLength = response.expectedContentLength
        guard expectedLength < 0 || expectedLength <= Int64(maximumBytes) else {
            bytes.task.cancel()
            throw GatewayBoundedDataError.responseTooLarge(maximumBytes: maximumBytes)
        }

        var data = Data()
        if expectedLength > 0 {
            data.reserveCapacity(Int(expectedLength))
        }
        return try await withTaskCancellationHandler {
            do {
                for try await byte in bytes {
                    guard data.count < maximumBytes else {
                        bytes.task.cancel()
                        throw GatewayBoundedDataError.responseTooLarge(maximumBytes: maximumBytes)
                    }
                    data.append(byte)
                }
            } catch {
                bytes.task.cancel()
                throw error
            }
            return (data, response)
        } onCancel: {
            // Cancellation after headers must also interrupt a stalled body.
            bytes.task.cancel()
        }
    }

    private func bytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do {
            // AsyncBytes owns a task delegate; without ours, its authentication
            // handling bypasses the session-level certificate policy.
            return try await self.session.bytes(for: request, delegate: self)
        } catch {
            throw self.consumeHTTPFailure(error)
        }
    }

    public func finishTasksAndInvalidate() {
        self.session.finishTasksAndInvalidate()
    }

    public func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void)
    {
        // Browser-session headers are origin-bound credentials. Their callers
        // disable redirects so URLSession cannot forward them to a sign-in or HTTP endpoint.
        completionHandler(self.allowsRedirects ? request : nil)
    }

    public func urlSession(
        _ session: URLSession,
        task _: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        self.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let host = challenge.protectionSpace.host
        let port = challenge.protectionSpace.port
        let expected = self.currentEnforcedFingerprint()
        guard let expectedAuthority = self.failureLock.withLock({ self.expectedAuthority }),
              expectedAuthority.matches(host: host, port: port)
        else {
            self.recordTLSFailure(GatewayTLSValidationFailure(
                kind: .authorityMismatch,
                host: host,
                storeKey: self.params.storeKey,
                expectedFingerprint: expected,
                observedFingerprint: nil,
                systemTrustOk: false,
                port: port))
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if self.evaluateServerTrust(trust, host: host, port: port, expectedFingerprint: expected) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

private final class GatewayHTTPResponseDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let responses = AsyncThrowingStream<URLResponse, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private let owner: GatewayTLSPinningSession

    init(owner: GatewayTLSPinningSession) {
        self.owner = owner
    }

    private func finish(with response: URLResponse) {
        self.responses.continuation.yield(response)
        self.responses.continuation.finish()
    }

    func urlSession(
        _: URLSession,
        dataTask _: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void)
    {
        self.finish(with: response)
        completionHandler(.cancel)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void)
    {
        self.owner.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: request)
        { nextRequest in
            if nextRequest == nil {
                // Declining a redirect normally drains its body. Complete from the headers
                // before cancellation so a stalled sign-in page cannot stall this probe.
                self.finish(with: response)
                task.cancel()
            }
            completionHandler(nextRequest)
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
        self.responses.continuation.finish(throwing: error ?? URLError(.badServerResponse))
    }
}

private func certificateFingerprint(_ trust: SecTrust) -> String? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let cert = chain.first
    else {
        return nil
    }
    return SHA256.hash(data: SecCertificateCopyData(cert) as Data)
        .map { String(format: "%02x", $0) }.joined()
}

private func normalizeFingerprint(_ raw: String) -> String {
    let stripped = raw.replacingOccurrences(
        of: #"(?i)^sha-?256\s*:?\s*"#,
        with: "",
        options: .regularExpression)
    return stripped.lowercased().filter(\.isHexDigit)
}
