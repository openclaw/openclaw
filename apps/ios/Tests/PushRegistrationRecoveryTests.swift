import CryptoKit
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

#if DEBUG
private actor RecoveryRelay: PushRelayRegistering {
    nonisolated let normalizedBaseURLString = "https://ios-push-relay.openclaw.ai"
    private(set) var enrollmentCount = 0

    func register(
        _ input: PushRelayRegistrationInput,
        isCurrent: @escaping @Sendable () async -> Bool) async throws -> PushRelayRegisterResponse
    {
        guard await isCurrent() else { throw CancellationError() }
        self.enrollmentCount += 1
        return PushRelayRegisterResponse(
            relayHandle: "renewed-handle", sendGrant: "renewed-grant",
            expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 3_600_000,
            tokenSuffix: nil, status: "registered")
    }
}

@Suite(.serialized)
struct PushRegistrationRecoveryTests {
    private func scope(installationID: String, gatewayID: String) -> PushRelayRegistrationStore.RegistrationScope {
        .init(
            installationId: installationID, gatewayDeviceId: gatewayID,
            relayOrigin: "https://ios-push-relay.openclaw.ai", apnsEnvironment: "production",
            relayProfile: "production", proofPolicy: "appleStrict", topic: "ai.openclaw.tests")
    }

    @Test func `rejected cache survives scope switches and reconstruction with bounded renewal`() async throws {
        _ = try #require(ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"])
        let service = "ai.openclawfoundation.app.pushrelay.tests"
        let originalLegacy = GenericPasswordKeychainStore.loadString(service: service, account: "registration-state")
        let installationID = try #require(GatewaySettingsStore.loadStableInstanceID())
        let scopeA = self.scope(installationID: installationID, gatewayID: "fixture-\(UUID().uuidString)")
        let scopeB = self.scope(installationID: installationID, gatewayID: "other-\(UUID().uuidString)")
        defer {
            for scope in [scopeA, scopeB] {
                GenericPasswordKeychainStore.delete(service: service, account: scope.account)
            }
            if let originalLegacy {
                GenericPasswordKeychainStore.saveString(originalLegacy, service: service, account: "registration-state")
            } else {
                GenericPasswordKeychainStore.delete(service: service, account: "registration-state")
            }
        }
        let token = String(repeating: "ab", count: 32)
        let tokenHash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        let state = PushRelayRegistrationStore.RegistrationState(
            relayHandle: "rejected-handle", sendGrant: "rejected-grant",
            relayOrigin: scopeA.relayOrigin, gatewayDeviceId: scopeA.gatewayDeviceId,
            relayHandleExpiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 3_600_000,
            tokenDebugSuffix: nil, lastAPNsTokenHashHex: tokenHash, installationId: installationID,
            lastTransport: "relay", apnsEnvironment: "production", relayProfile: "production",
            proofPolicy: "appleStrict")
        // Seed the shipped singleton layout. An unrelated scope must not adopt or erase it.
        let legacy = try #require(String(data: JSONEncoder().encode(state), encoding: .utf8))
        #expect(GenericPasswordKeychainStore.saveString(legacy, service: service, account: "registration-state"))
        #expect(PushRelayRegistrationStore.loadRegistrationState(scope: scopeB)?.relayHandle == nil)
        #expect(GenericPasswordKeychainStore.loadString(service: service, account: "registration-state") == legacy)

        let relay = RecoveryRelay()
        let config = PushBuildConfig(infoDictionary: ["OpenClawPushMode": "appStore"])
        let gatewayA = PushRelayGatewayIdentity(deviceId: scopeA.gatewayDeviceId, publicKey: "fixture-key")
        let gatewayB = PushRelayGatewayIdentity(deviceId: scopeB.gatewayDeviceId, publicKey: "other-key")
        let manager = PushRegistrationManager(buildConfig: config, relayClient: relay)
        let payload = try await manager.makeGatewayRegistrationPayload(
            apnsTokenHex: token, topic: scopeA.topic, gatewayIdentity: gatewayA)
        #expect(await relay.enrollmentCount == 0)
        #expect(GenericPasswordKeychainStore.loadString(service: service, account: "registration-state") == nil)
        try await manager.recordRejection(payloadJSON: payload)
        #expect(try await manager.beginRecovery(payloadJSON: payload, manual: false))

        let reconstructed = PushRegistrationManager(buildConfig: config, relayClient: relay)
        let replay = try await reconstructed.makeGatewayRegistrationPayload(
            apnsTokenHex: token, topic: scopeA.topic, gatewayIdentity: gatewayA)
        #expect(await reconstructed.isRejected(payloadJSON: replay))
        #expect(try await reconstructed.beginRecovery(payloadJSON: replay, manual: false) == false)
        #expect(await relay.enrollmentCount == 0)

        let renewed = try await reconstructed.makeGatewayRegistrationPayload(
            apnsTokenHex: token, topic: scopeA.topic, gatewayIdentity: gatewayA, forceRelayRenewal: true)
        let object = try #require(JSONSerialization.jsonObject(with: Data(renewed.utf8)) as? [String: Any])
        #expect(object["relayHandle"] as? String == "renewed-handle")
        #expect(await relay.enrollmentCount == 1)
        #expect(await reconstructed.isRejected(payloadJSON: renewed) == false)
        try await manager.recordRejection(payloadJSON: payload)
        #expect(PushRelayRegistrationStore.loadRegistrationState(scope: scopeA)?.rejected == false)
        try await reconstructed.recordRejection(payloadJSON: renewed)
        #expect(try await reconstructed.beginRecovery(payloadJSON: renewed, manual: false) == false)

        let otherPayload = try await manager.makeGatewayRegistrationPayload(
            apnsTokenHex: token, topic: scopeB.topic, gatewayIdentity: gatewayB)
        #expect(await relay.enrollmentCount == 2)
        try await manager.recordRejection(payloadJSON: otherPayload)
        #expect(try await manager.beginRecovery(payloadJSON: otherPayload, manual: false))
        let returnedPayload = try await manager.makeGatewayRegistrationPayload(
            apnsTokenHex: token, topic: scopeA.topic, gatewayIdentity: gatewayA)
        // Returning to rejected A must not reenroll before checking its consumed budget.
        #expect(await relay.enrollmentCount == 2)
        #expect(await manager.isRejected(payloadJSON: returnedPayload))
        #expect(try await manager.beginRecovery(payloadJSON: returnedPayload, manual: false) == false)
        #expect(PushRelayRegistrationStore.loadRegistrationState(scope: scopeB)?.rejected == true)
        #expect(try await manager.beginRecovery(payloadJSON: returnedPayload, manual: true))

        let changedToken = try await manager.makeGatewayRegistrationPayload(
            apnsTokenHex: String(repeating: "cd", count: 32), topic: scopeA.topic, gatewayIdentity: gatewayA)
        #expect(await relay.enrollmentCount == 3)
        try await manager.recordRejection(payloadJSON: changedToken)
        #expect(try await manager.beginRecovery(payloadJSON: changedToken, manual: false))
        #expect(try await manager.beginRecovery(payloadJSON: changedToken, manual: false) == false)
    }

    @Test func `direct AP ns does not use relay recovery`() async throws {
        let relay = RecoveryRelay()
        let manager = PushRegistrationManager(
            buildConfig: PushBuildConfig(infoDictionary: ["OpenClawPushMode": "localSandbox"]),
            relayClient: relay)
        let payload = try await manager.makeGatewayRegistrationPayload(
            apnsTokenHex: "direct-token", topic: "ai.openclaw.tests", gatewayIdentity: nil)
        let object = try #require(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect(object["transport"] as? String == "direct")
        #expect(object["token"] as? String == "direct-token")
        #expect(await relay.enrollmentCount == 0)
    }
}
#endif
