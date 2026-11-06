import CryptoKit
import Foundation

private struct DirectGatewayPushRegistrationPayload: Encodable {
    var transport: String = PushTransportMode.direct.rawValue
    var token: String
    var topic: String
    var environment: String
}

private struct RelayGatewayPushRegistrationPayload: Codable {
    var transport: String = PushTransportMode.relay.rawValue
    var relayHandle: String
    var sendGrant: String
    var gatewayDeviceId: String
    var installationId: String
    var topic: String
    var environment: String
    var distribution: String
    var relayOrigin: String
    var tokenDebugSuffix: String?
}

struct PushRelayGatewayIdentity: Codable, Sendable {
    var deviceId: String
    var publicKey: String
}

enum PushRegistrationHealth: Equatable {
    case notPublished, publishedUnverified, recovering, needsRetry, gatewayUpgradeRequired

    var detail: String {
        switch self {
        case .notPublished: "Registration not published; delivery unknown."
        case .publishedUnverified: "Registration published; delivery unverified."
        case .recovering: "Renewing APNs token registration and relay enrollment."
        case .needsRetry: "Notification setup needs attention. Retry with this Gateway connected."
        case .gatewayUpgradeRequired: "Gateway acknowledged publication without recovery feedback. Update the Gateway."
        }
    }
}

actor PushRegistrationManager {
    private let buildConfig: PushBuildConfig
    private let relayClient: (any PushRelayRegistering)?

    var usesRelayTransport: Bool {
        self.buildConfig.transport == .relay
    }

    init(buildConfig: PushBuildConfig = .current, relayClient: (any PushRelayRegistering)? = nil) {
        self.buildConfig = buildConfig
        self.relayClient = relayClient ?? buildConfig.relayBaseURL.map { PushRelayClient(baseURL: $0) }
    }

    func makeGatewayRegistrationPayload(
        apnsTokenHex: String,
        topic: String,
        gatewayIdentity: PushRelayGatewayIdentity?,
        forceRelayRenewal: Bool = false,
        isCurrent: @escaping @Sendable () async -> Bool = { true })
        async throws -> String
    {
        switch self.buildConfig.transport {
        case .direct:
            return try Self.encodePayload(
                DirectGatewayPushRegistrationPayload(
                    token: apnsTokenHex,
                    topic: topic,
                    environment: self.buildConfig.apnsEnvironment.rawValue))
        case .relay:
            guard let gatewayIdentity else {
                throw PushRelayError.relayMisconfigured("Missing gateway identity for relay registration")
            }
            return try await self.makeRelayPayload(
                apnsTokenHex: apnsTokenHex,
                topic: topic,
                gatewayIdentity: gatewayIdentity,
                forceRenewal: forceRelayRenewal,
                isCurrent: isCurrent)
        }
    }

    private func makeRelayPayload(
        apnsTokenHex: String,
        topic: String,
        gatewayIdentity: PushRelayGatewayIdentity,
        forceRenewal: Bool,
        isCurrent: @escaping @Sendable () async -> Bool)
    async throws -> String {
        guard let relayClient = self.relayClient else {
            throw PushRelayError.relayBaseURLMissing
        }
        guard let bundleId = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleId.isEmpty
        else {
            throw PushRelayError.relayMisconfigured("Missing bundle identifier for relay registration")
        }
        guard let installationId = GatewaySettingsStore.loadStableInstanceID() else {
            throw PushRelayError.relayMisconfigured("Missing stable installation ID for relay registration")
        }

        let tokenHashHex = Self.sha256Hex(apnsTokenHex)
        let relayOrigin = relayClient.normalizedBaseURLString
        let scope = PushRelayRegistrationStore.RegistrationScope(
            installationId: installationId,
            gatewayDeviceId: gatewayIdentity.deviceId,
            relayOrigin: relayOrigin,
            apnsEnvironment: self.buildConfig.apnsEnvironment.rawValue,
            relayProfile: self.buildConfig.relayProfile.rawValue,
            proofPolicy: self.buildConfig.proofPolicy.rawValue,
            topic: topic)
        let stored = PushRelayRegistrationStore.loadRegistrationState(scope: scope)
        let registrationState: PushRelayRegistrationStore.RegistrationState
        if !forceRenewal, let stored,
           stored.lastAPNsTokenHashHex == tokenHashHex,
           stored.rejected == true || !Self.isExpired(stored.relayHandleExpiresAtMs)
        {
            registrationState = stored
        } else {
            let input = PushRelayRegistrationInput(
                installationId: installationId,
                bundleId: bundleId,
                appVersion: DeviceInfoHelper.appVersion(),
                environment: self.buildConfig.apnsEnvironment,
                relayProfile: self.buildConfig.relayProfile,
                proofPolicy: self.buildConfig.proofPolicy,
                distribution: self.buildConfig.distribution,
                apnsTokenHex: apnsTokenHex,
                gatewayIdentity: gatewayIdentity)
            // NodeAppModel serializes the complete publication/recovery cycle, including token acquisition.
            let response = try await relayClient.register(input, isCurrent: isCurrent)
            guard await isCurrent() else { throw CancellationError() }
            registrationState = PushRelayRegistrationStore.RegistrationState(
                relayHandle: response.relayHandle,
                sendGrant: response.sendGrant,
                relayOrigin: relayOrigin,
                gatewayDeviceId: gatewayIdentity.deviceId,
                relayHandleExpiresAtMs: response.expiresAtMs,
                tokenDebugSuffix: Self.normalizeTokenSuffix(response.tokenSuffix),
                lastAPNsTokenHashHex: tokenHashHex,
                installationId: installationId,
                lastTransport: self.buildConfig.transport.rawValue,
                apnsEnvironment: self.buildConfig.apnsEnvironment.rawValue,
                relayProfile: self.buildConfig.relayProfile.rawValue,
                proofPolicy: self.buildConfig.proofPolicy.rawValue,
                rejected: false,
                recoveryAPNsTokenHashHex: stored?.recoveryAPNsTokenHashHex)
            guard PushRelayRegistrationStore.saveRegistrationState(registrationState, scope: scope) else {
                throw PushRelayError.relayMisconfigured("Could not save push registration. Retry notification setup.")
            }
        }
        return try Self.encodePayload(
            RelayGatewayPushRegistrationPayload(
                relayHandle: registrationState.relayHandle,
                sendGrant: registrationState.sendGrant,
                gatewayDeviceId: gatewayIdentity.deviceId,
                installationId: installationId,
                topic: topic,
                environment: self.buildConfig.apnsEnvironment.rawValue,
                distribution: self.buildConfig.distribution.rawValue,
                relayOrigin: relayOrigin,
                tokenDebugSuffix: registrationState.tokenDebugSuffix))
    }

    func isRejected(payloadJSON: String) -> Bool {
        self.matchingRegistration(payloadJSON: payloadJSON)?.state.rejected == true
    }

    func recordRejection(payloadJSON: String) throws {
        guard var registration = self.matchingRegistration(payloadJSON: payloadJSON) else { return }
        registration.state.rejected = true
        try self.saveRecoveryState(registration.state, scope: registration.scope)
    }

    /// Only the exact enrollment sent on the authenticated route may consume its recovery budget.
    func beginRecovery(payloadJSON: String, manual: Bool) throws -> Bool {
        guard var registration = self.matchingRegistration(payloadJSON: payloadJSON) else { return false }
        let allowed = registration.state.beginRecovery(manual: manual)
        // Persist before token acquisition; neither relaunch nor a Gateway switch resets this scope.
        try self.saveRecoveryState(registration.state, scope: registration.scope)
        return allowed
    }

    private func saveRecoveryState(
        _ state: PushRelayRegistrationStore.RegistrationState,
        scope: PushRelayRegistrationStore.RegistrationScope) throws
    {
        guard PushRelayRegistrationStore.saveRegistrationState(state, scope: scope) else {
            throw PushRelayError.relayMisconfigured("Could not save push recovery state. Retry notification setup.")
        }
    }

    private func matchingRegistration(payloadJSON: String)
        -> (state: PushRelayRegistrationStore.RegistrationState, scope: PushRelayRegistrationStore.RegistrationScope)?
    {
        guard let data = payloadJSON.data(using: .utf8),
              let payload = try? JSONDecoder().decode(RelayGatewayPushRegistrationPayload.self, from: data)
        else { return nil }
        let scope = PushRelayRegistrationStore.RegistrationScope(
            installationId: payload.installationId,
            gatewayDeviceId: payload.gatewayDeviceId,
            relayOrigin: payload.relayOrigin,
            apnsEnvironment: payload.environment,
            relayProfile: self.buildConfig.relayProfile.rawValue,
            proofPolicy: self.buildConfig.proofPolicy.rawValue,
            topic: payload.topic)
        guard let stored = PushRelayRegistrationStore.loadRegistrationState(scope: scope),
              stored.relayHandle == payload.relayHandle, stored.sendGrant == payload.sendGrant,
              stored.gatewayDeviceId == payload.gatewayDeviceId, stored.installationId == payload.installationId,
              stored.relayOrigin == payload.relayOrigin, stored.apnsEnvironment == payload.environment
        else { return nil }
        return (stored, scope)
    }

    private static func isExpired(_ expiresAtMs: Int64?) -> Bool {
        guard let expiresAtMs else { return true }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        // Refresh shortly before expiry so reconnect-path republishes a live handle.
        return expiresAtMs <= nowMs + 60000
    }

    private static func sha256Hex(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func normalizeTokenSuffix(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func encodePayload(_ payload: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw PushRelayError.relayMisconfigured("Failed to encode push registration payload as UTF-8")
        }
        return json
    }
}
