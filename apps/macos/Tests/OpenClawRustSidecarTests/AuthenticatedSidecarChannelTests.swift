import CryptoKit
import Foundation
import Testing
@testable import OpenClawRustSidecar

struct AuthenticatedSidecarChannelTests {
    @Test func `shared wire vectors are byte exact`() throws {
        let probe = try Self.fixture("protocol")
        let session = try #require(probe["session"] as? [String: Any])
        let supervisorProbe = try #require(probe["supervisorProbe"] as? [String: Any])
        let payload = try JSONSerialization.data(
            withJSONObject: #require(supervisorProbe["payload"]),
            options: .sortedKeys)
        let channel = try Self.channel(session)
        let expected = try Self.frame(supervisorProbe, "frameBase64")
        let sealed = try channel.seal(payload)
        #expect(sealed.dropFirst(4) == expected)
        #expect(sealed.prefix(4).reduce(0) { ($0 << 8) | Int($1) } == expected.count)

        let handshake = try Self.fixture("handshake")
        let handshakeSession = try #require(handshake["session"] as? [String: Any])
        let handshakeChannel = try Self.channel(handshakeSession)
        let offer = try Self.frame(handshake, "offerFrameBase64")
        let sessionID = try #require(handshakeSession["id"] as? String)
        let offerPayload = Data(offer.dropFirst(31 + sessionID.utf8.count).dropLast(32))
        #expect(try handshakeChannel.seal(offerPayload).dropFirst(4) == offer)
        let accepted = try handshakeChannel.open(Self.frame(handshake, "acceptFrameBase64"))
        let message = try #require(JSONSerialization.jsonObject(with: accepted) as? [String: Any])
        #expect(message["type"] as? String == "accept")
        #expect(try JSONSerialization.data(withJSONObject: #require(message["selection"]), options: .sortedKeys) ==
            JSONSerialization.data(withJSONObject: #require(handshake["selection"]), options: .sortedKeys))
    }

    @Test(arguments: ["mac", "magic", "version", "direction", "generation", "sequence", "session", "length", "json"])
    func `invalid inbound frame permanently retires channel`(mutation: String) throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        let valid = try Self.frame(fixture, "acceptFrameBase64")
        var invalid = valid
        let offsets = [
            "magic": 0,
            "version": 5,
            "direction": 8,
            "generation": 16,
            "sequence": 24,
            "session": 31,
            "length": 30,
        ]
        if mutation == "mac" {
            invalid[invalid.count - 1] ^= 1
        } else {
            let sessionID = try #require(session["id"] as? String)
            try invalid[mutation == "json" ? 31 + sessionID.utf8.count : #require(offsets[mutation])] ^= 1
            invalid = try Self.resign(invalid, session: session)
        }
        #expect(throws: (any Error).self) { try channel.open(invalid) }
        #expect(channel.isRetired)
        #expect(throws: AuthenticatedSidecarChannel.Failure.retired) { try channel.open(valid) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.retired) { try channel.seal(Data("{}".utf8)) }
    }

    @Test func `sequences survive negotiation and replay is terminal`() throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        let acceptance = try Self.frame(fixture, "acceptFrameBase64")
        _ = try channel.seal(Data("{}".utf8))
        _ = try channel.open(acceptance)
        try channel.lowerFrameLimit(2048)
        channel.lockFrameLimit()
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameLimitLocked) { try channel.lowerFrameLimit(1024) }
        let next = try channel.seal(Data("{}".utf8)).dropFirst(4)
        #expect(next.dropFirst(17).prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } == 2)
        #expect(throws: AuthenticatedSidecarChannel.Failure.wrongSequence) { try channel.open(acceptance) }
        #expect(channel.isRetired)
    }

    @Test func `limits reject oversized frames without spending outgoing sequence`() throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        try channel.lowerFrameLimit(128)
        #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) { try channel.lowerFrameLimit(4096) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) { try channel.lowerFrameLimit(64) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameTooLarge) {
            try channel.seal(Data(repeating: 0x20, count: channel.maxPayloadBytes + 1))
        }
        let exact = Data(("\"" + String(repeating: "x", count: channel.maxPayloadBytes - 2) + "\"").utf8)
        let sealed = try channel.seal(exact)
        #expect(sealed.count == 132)
        #expect(sealed.dropFirst(4 + 17).prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } == 1)
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameTooLarge) {
            try channel.open(Self.frame(fixture, "acceptFrameBase64"))
        }
        #expect(channel.isRetired)
    }

    @Test func `invalid bootstrap identity is rejected`() throws {
        for (keyBytes, sessionID, generation, limit) in [
            (31, "session", UInt64(1), 4096), (32, "", 1, 4096), (32, "session", 0, 4096),
            (32, "session", 1, 64), (32, "session", 1, Int(UInt32.max) + 1),
        ] {
            #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) {
                try AuthenticatedSidecarChannel(
                    key: Data(repeating: 0, count: keyBytes), sessionID: sessionID,
                    generation: generation, maxFrameBytes: limit)
            }
        }
    }

    private static func fixture(_ kind: String) throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            root.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: root.appendingPathComponent("test/fixtures/node-sidecar-\(kind)-v1.json"))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func frame(_ fixture: [String: Any], _ name: String) throws -> Data {
        let encoded = try #require(fixture[name] as? String)
        return try #require(Data(base64Encoded: encoded))
    }

    private static func key(_ session: [String: Any]) throws -> Data {
        try self.frame(session, session["keyBase64"] == nil ? "sessionKeyBase64" : "keyBase64")
    }

    private static func channel(_ session: [String: Any]) throws -> AuthenticatedSidecarChannel {
        try AuthenticatedSidecarChannel(
            key: self.key(session), sessionID: #require(session["id"] as? String),
            generation: #require(session["generation"] as? UInt64), maxFrameBytes: 4096)
    }

    private static func resign(_ frame: Data, session: [String: Any]) throws -> Data {
        var authenticated = Data(frame.dropLast(32))
        try authenticated.append(contentsOf: HMAC<SHA256>.authenticationCode(
            for: authenticated, using: SymmetricKey(data: Self.key(session))))
        return authenticated
    }
}
