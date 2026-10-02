import CryptoKit
import Foundation
import OpenClawKit

enum PushRelayRegistrationStore {
    private static let service = "ai.openclawfoundation.app.pushrelay"
    private static let registrationStateAccount = "registration-state"
    private static let appAttestKeyIDAccount = "app-attest-key-id"
    private static let appAttestedKeyIDAccount = "app-attested-key-id"

    struct AppAttestScope {
        var relayOrigin: String
        var apnsEnvironment: String
        var relayProfile: String
        var proofPolicy: String
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
    }

    static func loadRegistrationState() -> RegistrationState? {
        guard let raw = GenericPasswordKeychainStore.loadString(
            service: self.service,
            account: self.registrationStateAccount),
            let data = raw.data(using: .utf8)
        else {
            return nil
        }
        return try? JSONDecoder().decode(RegistrationState.self, from: data)
    }

    @discardableResult
    static func saveRegistrationState(_ state: RegistrationState) -> Bool {
        guard let data = try? JSONEncoder().encode(state),
              let raw = String(data: data, encoding: .utf8)
        else {
            return false
        }
        return GenericPasswordKeychainStore.saveString(
            raw,
            service: self.service,
            account: self.registrationStateAccount)
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
