import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

struct GatewayPersonalIdentityTests {
    @Test func `local route pins the Gateway certificate attested inside Serve binding`() throws {
        let localGatewayFingerprint = Self.fingerprint(byte: "a1")
        let differentServeCertificate = Self.fingerprint(byte: "b2")
        let localURL = try #require(URL(string: "wss://127.0.0.1:18789"))

        let route = try #require(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: localURL,
            gatewayFingerprint: localGatewayFingerprint))

        #expect(route.params.expectedFingerprint == localGatewayFingerprint)
        #expect(route.params.expectedFingerprint != differentServeCertificate)
        #expect(route.params.allowTOFU == false)
        #expect(route.allowsTrustedPinReplacement == false)
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: localGatewayFingerprint,
            observedFingerprint: localGatewayFingerprint,
            allowTOFU: route.params.allowTOFU,
            required: route.params.required,
            systemTrustOk: true) == .accept(
                fingerprint: localGatewayFingerprint,
                enforcePin: true,
                saveFirstUse: false))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: localGatewayFingerprint,
            observedFingerprint: differentServeCertificate,
            allowTOFU: route.params.allowTOFU,
            required: route.params.required,
            systemTrustOk: true) == .reject(.pinMismatch))
    }

    @Test func `personal local route rejects plaintext and nonlocal listeners`() throws {
        let fingerprint = Self.fingerprint(byte: "c3")
        #expect(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: try #require(URL(string: "ws://127.0.0.1:18789")),
            gatewayFingerprint: fingerprint) == nil)
        #expect(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: try #require(URL(string: "wss://gateway.example.ts.net")),
            gatewayFingerprint: fingerprint) == nil)
        #expect(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: try #require(URL(string: "wss://127.0.0.1:18789")),
            gatewayFingerprint: "not-a-fingerprint") == nil)
        #expect(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: try #require(URL(string: "wss://127.0.0.1:18789")),
            gatewayFingerprint: Array(repeating: "c3", count: 32).joined(separator: ":")) == nil)
    }

    @Test func `bound boot id must match local Primary Gateway hello`() {
        let server = ["bootId": OpenClawProtocol.AnyCodable("bound-gateway")]
        #expect(GatewayChannelActor.matchesExpectedGateway(server: server, expectedGatewayId: "bound-gateway"))
        #expect(!GatewayChannelActor.matchesExpectedGateway(server: server, expectedGatewayId: "other-gateway"))
        #expect(!GatewayChannelActor.matchesExpectedGateway(server: [:], expectedGatewayId: "bound-gateway"))
    }

    private static func fingerprint(byte: String) -> String {
        Array(repeating: byte, count: 32).joined()
    }
}
