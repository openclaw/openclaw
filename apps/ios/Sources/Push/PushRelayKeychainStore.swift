import CryptoKit
import Foundation
import OpenClawKit

enum PushRelayRegistrationStore {
    private static var service: String {
        #if DEBUG
        // Hosted tests share the app's Keychain group; never replace installed relay credentials.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return "ai.openclawfoundation.app.pushrelay.tests"
        }
        #endif
        return "ai.openclawfoundation.app.pushrelay"
    }

    private static let registrationStateAccount = "registration-state"
    private static let appAttestKeyIDAccount = "app-attest-key-id"
    private static let appAttestedKeyIDAccount = "app-attested-key-id"

    struct AppAttestScope {
        var relayOrigin: String
        var apnsEnvironment: String
        var relayProfile: String
        var proofPolicy: String
    }

    struct RegistrationScope {
        var installationId: String
        var gatewayDeviceId: String
        var relayOrigin: String
        var apnsEnvironment: String
        var relayProfile: String
        var proofPolicy: String
        var topic: String

        var account: String {
            let raw = [
                self.installationId, self.gatewayDeviceId, self.relayOrigin,
                self.apnsEnvironment, self.relayProfile, self.proofPolicy, self.topic,
            ].joined(separator: "\n")
            let digest = SHA256.hash(data: Data(raw.utf8))
                .map { String(format: "%02x", $0) }.joined()
            return "registration-state-\(digest)"
        }
    }

    struct RegistrationState: Codable {
        var relayHandle: String
        var sendGrant: String
        var relayOrigin: String?
        var gatewayDeviceId: String
        var relayHandleExpiresAtMs: Int64?
        var tokenDebugSuffix: String?
        var lastAPNsTokenHashHex: String
        var installationId: String
        var lastTransport: String
        var apnsEnvironment: String
        var relayProfile: String
        var proofPolicy: String
        var rejected: Bool?
        var recoveryAPNsTokenHashHex: String?

        func matches(_ scope: RegistrationScope) -> Bool {
            self.installationId == scope.installationId && self.gatewayDeviceId == scope.gatewayDeviceId &&
                self.relayOrigin == scope.relayOrigin && self.apnsEnvironment == scope.apnsEnvironment &&
                self.relayProfile == scope.relayProfile && self.proofPolicy == scope.proofPolicy
        }

        mutating func beginRecovery(manual: Bool) -> Bool {
            self.rejected = true
            guard manual || self.recoveryAPNsTokenHashHex != self.lastAPNsTokenHashHex else { return false }
            self.recoveryAPNsTokenHashHex = self.lastAPNsTokenHashHex
            return true
        }
    }

    static func loadRegistrationState(scope: RegistrationScope) -> RegistrationState? {
        if let state = self.loadRegistrationState(account: scope.account) { return state }
        // Migrate the shipped singleton only for its matching context. Another Gateway's
        // credentials stay intact; retire the legacy record only after saving its scoped copy.
        guard let legacy = self.loadRegistrationState(account: self.registrationStateAccount),
              legacy.matches(scope)
        else { return nil }
        if self.saveRegistrationState(legacy, scope: scope) {
            GenericPasswordKeychainStore.delete(service: self.service, account: self.registrationStateAccount)
        }
        return legacy
    }

    private static func loadRegistrationState(account: String) -> RegistrationState? {
        guard let raw = GenericPasswordKeychainStore.loadString(
            service: self.service,
            account: account)
        else {
            return nil
        }
        return try? JSONDecoder().decode(RegistrationState.self, from: Data(raw.utf8))
    }

    @discardableResult
    static func saveRegistrationState(_ state: RegistrationState, scope: RegistrationScope) -> Bool {
        guard let data = try? JSONEncoder().encode(state),
              let raw = String(data: data, encoding: .utf8)
        else {
            return false
        }
        return GenericPasswordKeychainStore.saveString(
            raw,
            service: self.service,
            account: scope.account)
    }

    static func loadAppAttestKeyID(scope: AppAttestScope) -> String? {
        GenericPasswordKeychainStore.loadString(
            service: self.service,
            account: self.scopedAccount(self.appAttestKeyIDAccount, scope: scope))?
            .trimmedNonEmpty
    }

    @discardableResult
    static func saveAppAttestKeyID(_ keyID: String, scope: AppAttestScope) -> Bool {
        GenericPasswordKeychainStore.saveString(
            keyID,
            service: self.service,
            account: self.scopedAccount(self.appAttestKeyIDAccount, scope: scope))
    }

    @discardableResult
    static func clearAppAttestKeyID(scope: AppAttestScope) -> Bool {
        GenericPasswordKeychainStore.delete(
            service: self.service,
            account: self.scopedAccount(self.appAttestKeyIDAccount, scope: scope))
    }

    static func loadAttestedKeyID(scope: AppAttestScope) -> String? {
        GenericPasswordKeychainStore.loadString(
            service: self.service,
            account: self.scopedAccount(self.appAttestedKeyIDAccount, scope: scope))?
            .trimmedNonEmpty
    }

    @discardableResult
    static func saveAttestedKeyID(_ keyID: String, scope: AppAttestScope) -> Bool {
        GenericPasswordKeychainStore.saveString(
            keyID,
            service: self.service,
            account: self.scopedAccount(self.appAttestedKeyIDAccount, scope: scope))
    }

    @discardableResult
    static func clearAttestedKeyID(scope: AppAttestScope) -> Bool {
        GenericPasswordKeychainStore.delete(
            service: self.service,
            account: self.scopedAccount(self.appAttestedKeyIDAccount, scope: scope))
    }

    private static func scopedAccount(_ baseAccount: String, scope: AppAttestScope) -> String {
        let raw = [
            scope.relayOrigin,
            scope.apnsEnvironment,
            scope.relayProfile,
            scope.proofPolicy,
        ].joined(separator: "\n")
        let digest = SHA256.hash(data: Data(raw.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        // A relay sees an App Attest key as attested only after receiving that
        // key's attestation object, so keep key state isolated per relay context.
        return "\(baseAccount)-\(digest)"
    }
}
