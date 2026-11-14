// Copyright (C) 2016 Bouke Haarsma
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//

import Foundation
import CryptoKit

/// SRP Client; the party that initializes the authentication and
/// must proof possession of the correct password.
public class Client<H: HashFunction> {
    let a: BigUInt
    let A: BigUInt

    let group: Group
    typealias impl = Implementation<H> // swiftlint:disable:this type_name

    let username: String
    var password: String?
    var precomputedX: BigUInt?

    var HAMK: Data?
    var K: Data?

    /// Whether the session is authenticated, i.e. the password
    /// was verified by the server and proof of a valid session
    /// key was provided by the server. If `true`, `sessionKey`
    /// is also available.
    public private(set) var isAuthenticated = false

    private init(
        username: String,
        group: Group = .N3072,
        privateKey: Data? = nil)
    {
        self.username = username
        self.group = group
        a = BigUInt(randomBytes(32))
        // A = g^a % N
        A = group.g.power(a, modulus: group.N)
    }

    /// Initialize the Client SRP party with a password.
    ///
    /// - Parameters:
    ///   - username: user's username.
    ///   - password: user's password.
    ///   - group: which `Group` to use, must be the same for the
    ///       server as well as the pre-stored verificationKey.
    ///   - privateKey: (optional) custom private key (a); if providing
    ///       the private key of the `Client`, make sure to provide a
    ///       good random key of at least 32 bytes. Default is to
    ///       generate a private key of 128 bytes. You MUST not re-use
    ///       the private key between sessions.
    public convenience init(
        username: String,
        password: String,
        group: Group = .N3072,
        privateKey: Data? = nil)
    {
        self.init(username: username, group: group, privateKey: privateKey)
        self.password = password
    }

    /// Initialize the Client SRP party with a precomputed x.
    ///
    /// - Parameters:
    ///   - username: user's username.
    ///   - precomputedX: precomputed SRP x.
    ///   - group: which `Group` to use, must be the same for the
    ///       server as well as the pre-stored verificationKey.
    ///   - privateKey: (optional) custom private key (a); if providing
    ///       the private key of the `Client`, make sure to provide a
    ///       good random key of at least 32 bytes. Default is to
    ///       generate a private key of 128 bytes. You MUST not re-use
    ///       the private key between sessions.
    public convenience init(
        username: String,
        precomputedX: Data,
        group: Group = .N3072,
        privateKey: Data? = nil)
    {
        self.init(username: username, group: group, privateKey: privateKey)
        self.precomputedX = BigUInt(precomputedX)
    }

    /// Starts authentication. This method is a no-op.
    ///
    /// - Returns: `username` (I) and `publicKey` (A)
    public func startAuthentication() -> (username: String, publicKey: Data) {
        return (username, publicKey)
    }

    /// Process the challenge provided by the server. This sets the `sessionKey`
    /// and generates proof that it generated the correct key from the password
    /// and the challenge. After the server has also proven the validity of their
    /// key, the `sessionKey` can be used.
    ///
    /// - Parameters:
    ///   - salt: user-specific salt (s)
    ///   - publicKey: server's public key (B)
    /// - Returns: key proof (M)
    /// - Throws: `AuthenticationFailure.invalidPublicKey` if the server's 
    ///     public key is invalid (i.e. B % N is zero).
    public func processChallenge(salt: Data, publicKey serverPublicKey: Data) throws -> (clientVerify: Data, sessionKey: SymmetricKey) {
        let H = impl.H
        let N = group.N

        let B = BigUInt(serverPublicKey)

        guard B % N != 0 else {
            throw AuthenticationFailure.invalidPublicKey
        }
        let u = impl.calculate_u(group: group, A: publicKey, B: serverPublicKey)
        let k = impl.calculate_k(group: group)
        let x = impl.calculate_x(salt: salt, username: username, password: password!)
        let v = calculate_v(group: group, x: x)

        // shared secret
        // S = (B - kg^x) ^ (a + ux)
        // Note that v = g^x, and that B - kg^x might become negative, which 
        // cannot be stored in BigUInt. So we'll add N to B_ and make sure kv
        // isn't greater than N.
        let S = (B + N - k * v % N).power(a + u * x, modulus: N)
        // session key
        K = H(S.serialize())
        let range: Range = 0..<32
        let sessionKey = SymmetricKey(data: K!.subdata(in: range))

        // client verification
        let M = impl.calculate_M(group: group, username: username, salt: salt, A: publicKey, B: serverPublicKey, K: K!)
        // server verification
        HAMK = impl.calculate_HAMK(A: publicKey, M: M, K: K!)
        return (clientVerify: M, sessionKey: sessionKey)
    }

    /// After the server has verified that the password is correct,
    /// it will send proof of the derived session key. This is verified
    /// on our end and finalizes the authentication session. After this
    /// step, the `sessionKey` is available.
    ///
    /// - Parameter HAMK: proof of the server that it derived the same
    ///     session key.
    /// - Throws: 
    ///    - `AuthenticationFailure.missingChallenge` if this method
    ///      is called before calling `processChallenge`.
    ///    - `AuthenticationFailure.keyProofMismatch` if the proof 
    ///      doesn't match our own.
    public func verifySession(keyProof serverKeyProof: Data) throws {
        guard let HAMK = HAMK else {
            throw AuthenticationFailure.missingChallenge
        }
        guard HAMK == serverKeyProof else {
            throw AuthenticationFailure.keyProofMismatch
        }
        isAuthenticated = true
    }

    /// The client's public key (A). For every authentication
    /// session a new public key is generated.
    public var publicKey: Data {
        return A.serialize()
    }

    /// The client's private key (a). For every authentication
    /// session a new random private key is generated.
    public var privateKey: Data {
        return a.serialize()
    }

    /// The session key (K) that is exchanged during authentication.
    /// This key can be used to encrypt further communication
    /// between client and server.
    public var sessionKey: Data? {
        guard isAuthenticated else {
            return nil
        }
        return K
    }
}
