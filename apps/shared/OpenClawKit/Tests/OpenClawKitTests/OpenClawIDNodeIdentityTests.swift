import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

struct OpenClawIDNodeIdentityTests {
    private enum HandoffError: Error { case interrupted }

    @Test(arguments: [false, true])
    func `native handoff preserves signing identity`(throwsDuringHandoff: Bool) async throws {
        let expectedSeed = Data((0..<32).map { UInt8($0) })
        let identity = try OpenClawIDNodeIdentity(seed: expectedSeed)
        let peerKey = identity.peerKey
        let signingKey = identity.signingKey
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation:
            OpenClawIDNodeIdentity.unhex(peerKey, prefix: "iroh:"))
        let message = Data("native handoff identity regression".utf8)
        #expect(try publicKey.isValidSignature(identity.sign(message), for: message))

        do {
            try await identity.withNativeSeed { seed in
                #expect(seed == expectedSeed)
                if throwsDuringHandoff { throw HandoffError.interrupted }
            }
            #expect(!throwsDuringHandoff)
        } catch HandoffError.interrupted {
            #expect(throwsDuringHandoff)
        }

        #expect(identity.peerKey == peerKey)
        #expect(identity.signingKey == signingKey)
        #expect(try publicKey.isValidSignature(identity.sign(message), for: message))
        try await identity.withNativeSeed { seed in
            #expect(seed == expectedSeed)
            let handedOffKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            #expect(handedOffKey.publicKey.rawRepresentation == publicKey.rawRepresentation)
        }
        #expect(identity.peerKey == peerKey)
        #expect(try publicKey.isValidSignature(identity.sign(message), for: message))
    }
}
