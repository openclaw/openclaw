import CryptoKit
import Foundation

/// Swift port of the protocol pieces an app needs to become an owner device: statement envelopes,
/// key fingerprints, the recovery kit and the new-device side of SAS approval. Each matches
/// `packages/openclaw-id-protocol` byte for byte (vectors in OpenClawIDOwnerEnrollment.json).
enum OpenClawIDStatement {
    /// `{ v, type, body, signer, alg, sig }` with sig = Ed25519 over `openclaw/<type>/v1\0` || JCS(body).
    static func sign(_ type: String, body: OpenClawIDCanonicalJSON, signer: OpenClawIDNodeIdentity) throws
        -> OpenClawIDCanonicalJSON
    {
        let signature = try signer.sign(Data("openclaw/\(type)/v1\0".utf8) + body.encoded)
        return .object([
            "v": .integer(1),
            "type": .string(type),
            "body": body,
            "signer": .string(signer.signingKey),
            "alg": .string("ed25519"),
            "sig": .string(OpenClawIDNodeIdentity.base64URL(signature)),
        ])
    }

    /// `fp:<hex SHA-256 of the raw key>` for an `ed25519:` or `iroh:` key.
    static func fingerprint(_ key: String) throws -> String {
        let prefix = key.hasPrefix("iroh:") ? "iroh:" : "ed25519:"
        return try "fp:" + OpenClawIDNodeIdentity.hex(SHA256.hash(data: OpenClawIDNodeIdentity.unhex(key, prefix: prefix)))
    }

    /// W's proof that it belongs with D for `bindDevice` (discovery.md, Device binding).
    static func peerKeyProof(accountID: String, device: OpenClawIDNodeIdentity, peer: OpenClawIDNodeIdentity, ts: Int64)
        throws -> String
    {
        let parts = OpenClawIDCanonicalJSON.object([
            "account_id": .string(accountID),
            "device_pub": .string(device.signingKey),
            "peer_key": .string(peer.peerKey),
            "ts": .integer(ts),
        ])
        return try OpenClawIDNodeIdentity.base64URL(peer.sign(Data("openclaw/peer-key-proof/v1\0".utf8) + parts.encoded))
    }
}

/// The recovery kit text (`OCK1-…`) and the root key R it derives. R exists only inside one
/// enrollment attempt; callers drop it when the attempt ends.
enum OpenClawIDRecoveryKit {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

    /// Decodes the 16-byte kit secret S, refusing a wrong prefix, version or checksum.
    static func decode(_ text: String) throws -> Data {
        let compact = text.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
        guard compact.hasPrefix("OCK1") else { throw OpenClawIDNodeEnrollmentError.malformed }
        var payload = try Self.crockford(String(compact.dropFirst(4)), count: 19)
        defer { payload.resetBytes(in: 0..<payload.count) }
        let body = payload.prefix(17)
        guard body.first == 1, Data(SHA256.hash(data: body).prefix(2)) == payload.suffix(2) else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        return Data(body.dropFirst())
    }

    /// R = Ed25519 from HKDF-SHA-256(S, salt `openclaw/owner-root/v1`, info `ed25519-seed`).
    static func root(_ text: String) throws -> OpenClawIDNodeIdentity {
        var secret = try Self.decode(text)
        defer { secret.resetBytes(in: 0..<secret.count) }
        var seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret),
            salt: Data("openclaw/owner-root/v1".utf8),
            info: Data("ed25519-seed".utf8),
            outputByteCount: 32).withUnsafeBytes { Data($0) }
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try OpenClawIDNodeIdentity(seed: seed)
    }

    private static func crockford(_ text: String, count: Int) throws -> Data {
        var out = Data()
        var buffer: UInt32 = 0
        var bits = 0
        for var byte in text.utf8 {
            if byte == UInt8(ascii: "I") || byte == UInt8(ascii: "L") { byte = UInt8(ascii: "1") }
            if byte == UInt8(ascii: "O") { byte = UInt8(ascii: "0") }
            guard let value = alphabet.firstIndex(of: byte) else { throw OpenClawIDNodeEnrollmentError.malformed }
            buffer = ((buffer << 5) | UInt32(value)) & 0xFFFF
            bits += 5
            if bits >= 8 {
                bits -= 8
                guard out.count < count else { throw OpenClawIDNodeEnrollmentError.malformed }
                out.append(UInt8((buffer >> UInt32(bits)) & 0xFF))
            }
        }
        guard out.count == count else { throw OpenClawIDNodeEnrollmentError.malformed }
        return out
    }
}

/// The new device N's side of SAS approval (enrollment.md, steps 1-9). E is the approving owner
/// device; Discovery relays the messages and may sit in the middle.
struct OpenClawIDSASNewDevice {
    let requestID: String
    /// The `start` fields N commits to (with `request_id`, without `commit`).
    let start: OpenClawIDCanonicalJSON
    let commit: String
    private let ephemeral: Curve25519.KeyAgreement.PrivateKey

    init(start: OpenClawIDCanonicalJSON, requestID: String, ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) {
        self.requestID = requestID
        self.start = start
        self.ephemeral = ephemeral
        self.commit = OpenClawIDNodeIdentity.hex(SHA256.hash(
            data: ephemeral.publicKey.rawRepresentation + start.encoded))
    }

    /// The `start` mail data: every committed field except `request_id`, plus `commit`.
    var startData: OpenClawIDCanonicalJSON {
        guard case var .object(fields) = self.start else { return self.start }
        fields["request_id"] = nil
        fields["commit"] = .string(self.commit)
        return .object(fields)
    }

    var ephemeralPublicHex: String {
        OpenClawIDNodeIdentity.hex(self.ephemeral.publicKey.rawRepresentation)
    }

    /// Steps 4-5 on E's `accept`: the shared secret, the transcript and the six digits.
    func accepted(ephemeralE: String, devicePubE: String) throws -> Accepted {
        let raw = try OpenClawIDNodeIdentity.unhex(ephemeralE)
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
        let shared = try self.ephemeral.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        let transcript = Data(SHA256.hash(data: OpenClawIDCanonicalJSON.object([
            "start": self.start,
            "commit": .string(self.commit),
            "eph_e": .string(OpenClawIDNodeIdentity.hex(raw)),
            "eph_n": .string(self.ephemeralPublicHex),
            "device_pub_e": .string(devicePubE),
        ]).encoded))
        return Accepted(sharedSecret: shared, transcript: transcript)
    }

    struct Accepted {
        let sharedSecret: Data
        let transcript: Data

        /// HKDF(ss, info `openclaw/sas/v1` || hex(T)) as a zero-padded six-digit number.
        var code: String {
            let bytes = Self.derive(self.sharedSecret, info: "openclaw/sas/v1", transcript: self.transcript, count: 4)
            let value = bytes.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
            return String(format: "%06u", value % 1_000_000)
        }

        /// Step 9: opens E's AES-256-GCM handoff, or nil when it was not sealed under this transcript.
        func open(nonce: String, ciphertext: String) -> OpenClawIDCanonicalJSON? {
            guard let nonceBytes = Self.unhexAny(nonce), let sealed = Self.unhexAny(ciphertext), sealed.count >= 16,
                  let box = try? AES.GCM.SealedBox(
                      nonce: AES.GCM.Nonce(data: nonceBytes),
                      ciphertext: sealed.dropLast(16),
                      tag: sealed.suffix(16))
            else { return nil }
            let key = SymmetricKey(data: Self.derive(
                self.sharedSecret, info: "openclaw/sas-mac/v1", transcript: self.transcript, count: 32))
            guard let plain = try? AES.GCM.open(box, using: key) else { return nil }
            return try? OpenClawIDCanonicalJSON.parse(plain)
        }

        private static func derive(_ secret: Data, info: String, transcript: Data, count: Int) -> Data {
            HKDF<SHA256>.deriveKey(
                inputKeyMaterial: SymmetricKey(data: secret),
                salt: Data(),
                info: Data((info + OpenClawIDNodeIdentity.hex(transcript)).utf8),
                outputByteCount: count).withUnsafeBytes { Data($0) }
        }

        private static func unhexAny(_ text: String) -> Data? {
            guard text.count.isMultiple(of: 2), text.count <= 131_072,
                  OpenClawIDNodeEnrollmentLink.matches(text, "^[0-9a-f]*$") else { return nil }
            var result = Data(capacity: text.count / 2)
            var index = text.startIndex
            while index < text.endIndex {
                let next = text.index(index, offsetBy: 2)
                guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
                result.append(byte)
                index = next
            }
            return result
        }
    }
}
