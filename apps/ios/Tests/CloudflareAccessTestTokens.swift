import Foundation
import Security
import Testing
@testable import OpenClaw

/// Runtime signing exercises the platform verifier without storing a private signing key in fixtures.
struct CloudflareAccessTestTokens {
    let key: SecKey
    let jwks: Data

    init() throws {
        self.key = try #require(SecKeyCreateRandomKey([
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 2048,
        ] as CFDictionary, nil))
        let publicKey = try #require(SecKeyCopyPublicKey(self.key))
        let der = try #require(SecKeyCopyExternalRepresentation(publicKey, nil)) as Data
        var outer = Array(der)[...]
        var sequence = try Self.readDER(&outer, tag: 0x30)[...]
        var modulus = try Self.readDER(&sequence, tag: 0x02)
        if modulus.first == 0 { modulus.removeFirst() }
        let exponent = try Self.readDER(&sequence, tag: 0x02)
        self.jwks = try JSONSerialization.data(withJSONObject: ["keys": [[
            "kty": "RSA", "kid": "test-key", "alg": "RS256", "use": "sig",
            "n": Self.encode(Data(modulus)), "e": Self.encode(Data(exponent)),
        ]]])
    }

    static func application() throws -> CloudflareAccessApplication {
        try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test:8443"))),
            issuer: #require(URL(string: "https://example.cloudflareaccess.com")),
            audience: "test-audience")
    }

    func token(_ claims: [String: Any], algorithm: String = "RS256") throws -> String {
        let header = try JSONSerialization.data(withJSONObject: ["alg": algorithm, "kid": "test-key"])
        let payload = try JSONSerialization.data(withJSONObject: claims)
        let message = "\(Self.encode(header)).\(Self.encode(payload))"
        let signature = try #require(SecKeyCreateSignature(
            self.key, .rsaSignatureMessagePKCS1v15SHA256, Data(message.utf8) as CFData, nil)) as Data
        return "\(message).\(Self.encode(signature))"
    }

    func session(subject: String = "test-subject", expires: Date = Date().addingTimeInterval(3600)) throws
        -> CloudflareAccessSession
    {
        let application = try Self.application()
        let token = try self.token([
            "iss": application.issuer.absoluteString, "aud": [application.audience],
            "type": "app", "sub": subject, "exp": expires.timeIntervalSince1970,
        ])
        return CloudflareAccessSession(application: application, subject: subject, token: token, expiresAt: expires)
    }

    private static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func readDER(_ bytes: inout ArraySlice<UInt8>, tag: UInt8) throws -> [UInt8] {
        let actualTag = bytes.popFirst()
        #expect(actualTag == tag)
        let lengthByte = bytes.popFirst()
        let first = try #require(lengthByte)
        var length = Int(first)
        if first >= 128 {
            length = 0
            for _ in 0..<(first & 0x7F) {
                let next = bytes.popFirst()
                length = try length * 256 + Int(#require(next))
            }
        }
        #expect(bytes.count >= length)
        let value = Array(bytes.prefix(length))
        bytes = bytes.dropFirst(length)
        return value
    }
}
