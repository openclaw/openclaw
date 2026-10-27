import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct GatewayConnectChallengeSupportTests {
    @Test func `parses gateway issued timestamp`() {
        let challenge = GatewayConnectChallenge(payload: [
            "nonce": AnyCodable(" nonce-1 "),
            "ts": AnyCodable(1_700_000_000_123),
        ])

        #expect(challenge == GatewayConnectChallenge(
            nonce: "nonce-1",
            issuedAtMs: 1_700_000_000_123))
    }

    @Test func `rejects malformed challenge`() {
        let payloads: [[String: AnyCodable]] = [
            ["nonce": AnyCodable("nonce-1"), "ts": AnyCodable("1700000000123")],
            ["nonce": AnyCodable("nonce-1"), "ts": AnyCodable(-1)],
            ["nonce": AnyCodable(" "), "ts": AnyCodable(1_700_000_000_123)],
        ]
        for payload in payloads {
            #expect(GatewayConnectChallenge(payload: payload) == nil)
        }
    }

    @Test func `rejects challenge without timestamp`() {
        #expect(GatewayConnectChallenge(payload: [
            "nonce": AnyCodable("nonce-1"),
        ]) == nil)
    }
}
