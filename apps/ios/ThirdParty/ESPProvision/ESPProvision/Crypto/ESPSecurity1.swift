// Copyright 2020 Espressif Systems
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
//  ESPSecurity1.swift
//  ESPProvision
//


import Foundation
import Security
import SwiftProtobuf
import CryptoKit

/// Enum type which encapsulates different states of a secured session.
enum Security1SessionState: Int {
    /// Initial resuest of a session.
    case Request1
    /// Received response for first state.
    case Response1Request2
    /// Response Receive for second state.
    case Response2
    /// Handshake finished.
    case Finished
}

/// The `ESPSecurity1` class conforms and implememnt methods of `ESPCodeable` protocol.
/// This class provides methods for handling request/response data in a secure communication.
class ESPSecurity1: ESPCodeable {
    
    private static let basePoint = Data([9] + [UInt8](repeating: 0, count: 31))

    private var sessionState: Security1SessionState = .Request1
    private var proofOfPossession: Data?
    private var privateKey: Curve25519.KeyAgreement.PrivateKey?
    private var publicKey: Curve25519.KeyAgreement.PublicKey?
    private var clientVerify: Data?
    private var cryptoAES: CryptoAES?

    private var sharedKey: Data?
    private var deviceRandom: Data?

    /// Create Security 1 implementation with given proof of possession
    ///
    /// - Parameter proofOfPossession: Proof of possession identifying the  `ESPdevice`.
    init(proofOfPossession: String) {
        ESPLog.log("Initailising secure class with proof of possession.")
        self.proofOfPossession = proofOfPossession.data(using: .utf8)
        generateKeyPair()
    }

    /// Get the next request based upon the current session,
    /// state and the response data passed to this function
    ///
    /// - Parameter data: Data that was received in the previous step.
    /// - Returns: Data to be sent in the next step.
    /// - Throws: Security errors.
    func getNextRequestInSession(data: Data?) throws -> Data? {
        ESPLog.log("Getting next request in session.")
        var request: Data?
        do {
            switch sessionState {
            case .Request1:
                sessionState = .Response1Request2
                request = try getStep0Request()
            case .Response1Request2:
                sessionState = .Response2
                try processStep0Response(response: data)
                request = try getStep1Request()
            case .Response2:
                sessionState = .Finished
                try processStep1Response(response: data)
            default:
                request = nil
            }
        } catch {
            throw error
        }

        return request
    }

    /// Encrypt data received in argument.
    ///
    /// - Parameter data: Data to be sent.
    /// - Returns: Encrypted data.
    func encrypt(data: Data) -> Data? {
        ESPLog.log("Encrypting data security 1.")
        guard let cryptoAES = self.cryptoAES else {
            return nil
        }
        return cryptoAES.encrypt(data: data)
    }

    /// Decrypt data received in argument.
    ///
    /// - Parameter data: Data to be sent.
    /// - Returns: Decrypted data.
    func decrypt(data: Data) -> Data? {
        ESPLog.log("Decrypting data security 1.")
        guard let cryptoAES = self.cryptoAES else {
            return nil
        }
        return cryptoAES.encrypt(data: data)
    }

    private func generatePrivateKey() -> Data? {
        ESPLog.log("Generating random private key.")
        
        return Curve25519.Signing.PrivateKey().rawRepresentation
    }

    private func generateKeyPair() {
        ESPLog.log("Generating key pair for encrypting data.")
        self.privateKey = CryptoKit.Curve25519.KeyAgreement.PrivateKey()
        guard self.privateKey != nil else {
            publicKey = nil
            return
        }
        publicKey = self.privateKey?.publicKey
    }

    /// Generate data to send on Step 0 of session request.
    ///
    /// - Throws: Error generated on getting data from session object.
    private func getStep0Request() throws -> Data? {
        guard let publicKey = self.publicKey else {
            throw SecurityError.keygenError("Could not generate keypair")
        }
        var sessionData = SessionData()
        sessionData.secVer = .secScheme1
        sessionData.sec1.sc0.clientPubkey = publicKey.rawRepresentation
        do {
            return try sessionData.serializedData()
        } catch {
            throw SecurityError.handshakeError("Cannot create handshake request 0")
        }
    }

    /// Generate data to send on Step 1 of session request.
    ///
    /// - Throws: Error generated on getting data from session object.
    private func getStep1Request() throws -> Data? {
        guard let verifyData = self.clientVerify else {
            ESPLog.log("Could not generate keypair")
            throw SecurityError.keygenError("Could not generate keypair")
        }

        var sessionData = SessionData()
        sessionData.secVer = .secScheme1
        sessionData.sec1.msg = .sessionCommand1
        sessionData.sec1.sc1.clientVerifyData = verifyData
        do {
            ESPLog.log("Serializing data")
            return try sessionData.serializedData()
        } catch {
            ESPLog.log("Cannot create handshake request 1")
            throw SecurityError.handshakeError("Cannot create handshake request 1")
        }
    }

    /// Processes data received as reponse of Step 0 request.
    ///
    /// - Parameter response: Step 0 response.
    /// - Throws: Security errors.
    private func processStep0Response(response: Data?) throws {
        guard let response = response else {
            ESPLog.log("Response 0 is nil.")
            throw SecurityError.handshakeError("Response 0 is nil")
        }
        let sessionData = try SessionData(serializedData: response)
        if sessionData.secVer != .secScheme1 {
            ESPLog.log("Security version mismatch.")
            throw SecurityError.handshakeError("Security version mismatch")
        }

        let devicePublicKey = sessionData.sec1.sr0.devicePubkey
        let deviceRandom = sessionData.sec1.sr0.deviceRandom
        do {
            let sharedKey = try privateKey?.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: devicePublicKey))
            if var sharedKeyData = sharedKey?.withUnsafeBytes({Data($0)}) {
                if let pop = self.proofOfPossession, pop.count > 0 {
                    let digest = pop.sha256()
                    sharedKeyData = HexUtils.xor(first: sharedKeyData, second: digest)
                }

                cryptoAES = CryptoAES(key: sharedKeyData, iv: deviceRandom)

                let verifyBytes = encrypt(data: devicePublicKey)

                if verifyBytes == nil {
                    ESPLog.log("Cannot encrypt device key")
                    throw SecurityError.handshakeError("Cannot encrypt device key")
                }
                
                ESPLog.log("Step0 response processed.")
                clientVerify = verifyBytes
            }
        } catch {
            ESPLog.log(error.localizedDescription)
        }
    }
    
    /// Processes data received as reponse of Step 1 request.
    ///
    /// - Parameter response: Step 1 response.
    /// - Throws: Security errors.
    private func processStep1Response(response: Data?) throws {
        guard let response = response else {
            ESPLog.log("Response 1 is nil")
            throw SecurityError.handshakeError("Response 1 is nil")
        }
        let sessionData = try SessionData(serializedData: response)
        if sessionData.secVer != .secScheme1 {
            ESPLog.log("Security version mismatch")
            throw SecurityError.handshakeError("Security version mismatch")
        }

        let deviceVerify = sessionData.sec1.sr1.deviceVerifyData
        let decryptedDeviceVerify = decrypt(data: deviceVerify)
        if let decryptedDeviceVerify = decryptedDeviceVerify,
           !decryptedDeviceVerify.bytes.elementsEqual(self.publicKey!.rawRepresentation.bytes) {
            ESPLog.log("Key mismatch")
            throw SecurityError.handshakeError("Key mismatch")
        }
    }
}

