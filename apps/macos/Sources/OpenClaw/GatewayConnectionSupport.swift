import CryptoKit
import Foundation
import OSLog
import Security

extension GatewayConnection {
    nonisolated static let requestRetryDelaysMs = [150, 400, 900]
}

@MainActor
final class GatewayStoreRefresh {
    let revision: UInt64?
    var lease: GatewayConnection.ServerLease?
    var task: Task<Void, Never>?

    init(revision: UInt64?) {
        self.revision = revision
    }

    func isCurrent(on gateway: GatewayConnection) -> Bool {
        self.task?.isCancelled != true && self.revision == gateway.selectedEndpointRevision &&
            self.lease.map(gateway.serverLeaseMatchesCurrentState) != false
    }
}

struct GatewayRouteChangedAfterDispatchError: LocalizedError, Sendable {
    let method: String

    var errorDescription: String? {
        "The Gateway route changed after \(self.method) was sent. Its result is unknown; refresh before retrying."
    }
}

enum GatewayActivationBindingKeyStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")
    // Dev builds carry a different code signature; creating the release item
    // would poison its Keychain ACL and make the shipped app demand the login
    // keychain password on every read. DEBUG is a config heuristic, not a
    // signing check — same accepted tradeoff as MacGatewayProfileStore.service.
    #if DEBUG
    private static let baseService = "ai.openclaw.onboarding-route-binding.debug"
    #else
    private static let baseService = "ai.openclaw.onboarding-route-binding"
    #endif
    static var service: String {
        AppProfile.current.keychainService(base: self.baseService)
    }

    private static let account = "credential-binding-v1"
    private static let byteCount = 32

    static func loadOrCreate() -> SymmetricKey? {
        if let data = load() {
            return SymmetricKey(data: data)
        }

        var data = Data(count: byteCount)
        let randomStatus = data.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, self.byteCount, baseAddress)
        }
        guard randomStatus == errSecSuccess else { return nil }

        var query = self.baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return SymmetricKey(data: data)
        }
        // Another process can win the first-launch create race. Only accept the
        // secret after reading the Keychain item back through normal ACL checks.
        if addStatus == errSecDuplicateItem, let existing = load() {
            return SymmetricKey(data: existing)
        }
        self.reportDeferredAuthorization(addStatus)
        return nil
    }

    private static func load() -> Data? {
        var query = self.baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        self.reportDeferredAuthorization(status)
        guard status == errSecSuccess,
              let data = result as? Data,
              data.count == byteCount
        else { return nil }
        return data
    }

    private static func reportDeferredAuthorization(_ status: OSStatus) {
        guard !AppLaunchRuntimePlan.current.allowsActivation,
              status != errSecSuccess, status != errSecItemNotFound else { return }
        self.logger.error(
            """
            Keychain binding unavailable (\(status)): --no-activate disables authorization dialogs; \
            relaunch without the flag and retry.
            """)
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}
