import Foundation

private struct StoredPushRelayRegistrationState: Codable {
    var relayHandle: String
    var sendGrant: String
    var relayOrigin: String?
    var gatewayDeviceId: String
    var relayHandleExpiresAtMs: Int64?
    var tokenDebugSuffix: String?
    var lastAPNsTokenHashHex: String
    var installationId: String
    var lastTransport: String
}

enum PushRelayRegistrationStore {
    private static let service = "ai.vericlaw.pushrelay"
    private static let legacyService = "ai.openclaw.pushrelay"
    private static let registrationStateAccount = "registration-state"
    private static let appAttestKeyIDAccount = "app-attest-key-id"
    private static let appAttestedKeyIDAccount = "app-attested-key-id"

    private static func loadString(account: String) -> String? {
        KeychainStore.loadString(service: self.service, account: account)
            ?? KeychainStore.loadString(service: self.legacyService, account: account)
    }

    @discardableResult
    private static func saveString(_ value: String, account: String) -> Bool {
        let saved = KeychainStore.saveString(value, service: self.service, account: account)
        _ = KeychainStore.delete(service: self.legacyService, account: account)
        return saved
    }

    @discardableResult
    private static func deleteString(account: String) -> Bool {
        let deletedCurrent = KeychainStore.delete(service: self.service, account: account)
        let deletedLegacy = KeychainStore.delete(service: self.legacyService, account: account)
        return deletedCurrent || deletedLegacy
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
    }

    static func loadRegistrationState() -> RegistrationState? {
        guard let raw = self.loadString(account: self.registrationStateAccount),
            let data = raw.data(using: .utf8),
            let decoded = try? JSONDecoder().decode(StoredPushRelayRegistrationState.self, from: data)
        else {
            return nil
        }
        return RegistrationState(
            relayHandle: decoded.relayHandle,
            sendGrant: decoded.sendGrant,
            relayOrigin: decoded.relayOrigin,
            gatewayDeviceId: decoded.gatewayDeviceId,
            relayHandleExpiresAtMs: decoded.relayHandleExpiresAtMs,
            tokenDebugSuffix: decoded.tokenDebugSuffix,
            lastAPNsTokenHashHex: decoded.lastAPNsTokenHashHex,
            installationId: decoded.installationId,
            lastTransport: decoded.lastTransport)
    }

    @discardableResult
    static func saveRegistrationState(_ state: RegistrationState) -> Bool {
        let stored = StoredPushRelayRegistrationState(
            relayHandle: state.relayHandle,
            sendGrant: state.sendGrant,
            relayOrigin: state.relayOrigin,
            gatewayDeviceId: state.gatewayDeviceId,
            relayHandleExpiresAtMs: state.relayHandleExpiresAtMs,
            tokenDebugSuffix: state.tokenDebugSuffix,
            lastAPNsTokenHashHex: state.lastAPNsTokenHashHex,
            installationId: state.installationId,
            lastTransport: state.lastTransport)
        guard let data = try? JSONEncoder().encode(stored),
              let raw = String(data: data, encoding: .utf8)
        else {
            return false
        }
        return self.saveString(raw, account: self.registrationStateAccount)
    }

    @discardableResult
    static func clearRegistrationState() -> Bool {
        self.deleteString(account: self.registrationStateAccount)
    }

    static func loadAppAttestKeyID() -> String? {
        let value = self.loadString(account: self.appAttestKeyIDAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    @discardableResult
    static func saveAppAttestKeyID(_ keyID: String) -> Bool {
        self.saveString(keyID, account: self.appAttestKeyIDAccount)
    }

    @discardableResult
    static func clearAppAttestKeyID() -> Bool {
        self.deleteString(account: self.appAttestKeyIDAccount)
    }

    static func loadAttestedKeyID() -> String? {
        let value = self.loadString(account: self.appAttestedKeyIDAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    @discardableResult
    static func saveAttestedKeyID(_ keyID: String) -> Bool {
        self.saveString(keyID, account: self.appAttestedKeyIDAccount)
    }

    @discardableResult
    static func clearAttestedKeyID() -> Bool {
        self.deleteString(account: self.appAttestedKeyIDAccount)
    }
}
