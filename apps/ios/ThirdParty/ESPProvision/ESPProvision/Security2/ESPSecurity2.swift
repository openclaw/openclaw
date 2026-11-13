// Copyright 2022 Espressif Systems
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
//  ESPSecurity2.swift
//  ESPProvision
//

import Foundation
import Security
import SwiftProtobuf
import CryptoKit

/// Enum type which encapsulates different states of a secured session.
enum Security2SessionState: Int {
    /// Initial request of a session.
    case Request1
    /// Received response for first state.
    case Response1Request2
    /// Response received for second state.
    case Response2
    /// Handshake finished.
    case Finished
}

/// The `ESPSecurity2` class implements secure communication with ESP devices using SRP6a and AES-GCM.
/// This class provides methods for handling request/response data in a secure communication.
class ESPSecurity2: ESPCodeable {
    
    private static let basePoint = Data([9] + [UInt8](repeating: 0, count: 31))

    private var sessionState: Security2SessionState = .Request1
    private var privateKey: Data?
    private var publicKey: Data?
    private var clientVerify: Data?
    private var username: String
    private var password: String
    private var srp6a: Client<SHA512>
    private var nonce: AES.GCM.Nonce?
    var sessionKey: SymmetricKey?
    
    // MARK: - AES-GCM IV Management Properties
    var useCounter: Bool = false
    
    /// Device nonce received from device (first 8 bytes used as session ID)
    private var deviceNonce: Data?
    
    /// Counter for IV generation (last 4 bytes)
    private var counter: UInt32 = 1
    
    /// Size of the counter component in IV
    private let counterSize = 4
    
    /// Size of the session ID component in IV
    private let sessionIdSize = 8

    // MARK: - Initialization
    
    /// Initialize Security 2 implementation with given credentials
    ///
    /// - Parameters:
    ///   - username: Username for authentication
    ///   - password: Password for authentication
    init(username: String, password: String, useCounterFlag: Bool = false) {
        ESPLog.log("Initialising secure class")
        self.username = username
        self.password = password
        self.useCounter = useCounterFlag
        self.srp6a = Client<SHA512>(username: username, password: password)
        self.publicKey = randomBytes(32)
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
        guard let sessionKey = sessionKey else {
            ESPLog.log("Encryption failed: session key is not available.")
            return nil
        }
        do {
            if self.useCounter {
                // Create 12-byte IV by combining session ID and counter
                let iv = constructIV()
                self.nonce = try AES.GCM.Nonce(data: iv)
                guard let nonce = self.nonce else {
                    ESPLog.log("Encryption failed: nonce is not available.")
                    return nil
                }
                
                let encryptedData = try AES.GCM.seal(data, using: sessionKey, nonce: nonce)
                
                // Increment counter after successful encryption
                incrementCounter()
                
                return encryptedData.ciphertext + encryptedData.tag
            } else {
                guard let nonce = self.nonce else {
                    ESPLog.log("Encryption failed: nonce is not available.")
                    return nil
                }
                let encryptedData = try AES.GCM.seal(data, using: sessionKey, nonce: nonce)
                return encryptedData.ciphertext + encryptedData.tag
            }
        } catch {
            ESPLog.log("Encryption failed with error:" + error.localizedDescription)
            return nil
        }
    }

    /// Decrypt data received in argument.
    ///
    /// - Parameter data: Data to be sent.
    /// - Returns: Decrypted data.
    func decrypt(data: Data) -> Data? {
        guard let sessionKey = sessionKey else {
            ESPLog.log("Decryption failed: session key is not available.")
            return nil
        }
        do {
            if self.useCounter {
                // Create 12-byte IV by combining session ID and counter
                let iv = constructIV()
                self.nonce = try AES.GCM.Nonce(data: iv)
                guard let nonce = self.nonce else {
                    ESPLog.log("Decryption failed: nonce is not available.")
                    return nil
                }
                
                let range: Range = (data.count - 16)..<data.count
                let tag = data.subdata(in: range)
                let dataRange: Range = 0..<(data.count - 16)
                let cipherText = data.subdata(in: dataRange)
                
                let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: cipherText, tag: tag)
                let decryptedData = try AES.GCM.open(sealedBox, using: sessionKey)
                
                // Increment counter after successful decryption
                incrementCounter()
                
                return decryptedData
            } else {
                guard let nonce = self.nonce else {
                    ESPLog.log("Decryption failed: nonce is not available.")
                    return nil
                }
                let range: Range = (data.count - 16)..<data.count
                let tag = data.subdata(in: range)
                let dataRange:Range = 0..<(data.count - 16)
                let cipherText = data.subdata(in: dataRange)
                let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: cipherText, tag: tag)
                return try AES.GCM.open(sealedBox, using: sessionKey)
            }
        } catch {
            ESPLog.log("Decryption failed with error:" + error.localizedDescription)
            return nil
        }
    }

    private func generatePrivateKey() -> Data? {
        ESPLog.log("Generating random private key.")
        var keyData = Data(count: 32)
        let result = keyData.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
        }
        if result == errSecSuccess {
            return keyData
        } else {
            ESPLog.log("Error generating random bytes.")
            return nil
        }
    }

    private func generateKeyPair() {
        ESPLog.log("Generating key pair for encrypting data.")
        publicKey = srp6a.publicKey
        privateKey = srp6a.privateKey
    }

    /// Constructs the 12-byte IV using session ID and counter
    private func constructIV() -> Data {
        ESPLog.log("Constructing 12-byte IV using session ID and counter.")
        guard let deviceNonce = self.deviceNonce else {
            return Data(repeating: 0, count: 12)
        }
        
        // Take first 8 bytes from device nonce as session ID
        var iv = Data(deviceNonce.prefix(sessionIdSize))
        
        // Append 4-byte counter in big-endian format
        iv.append(contentsOf: withUnsafeBytes(of: counter.bigEndian) { Data($0) })
        
        return iv
    }
    
    /// Increments the counter after each operation
    private func incrementCounter() {
        counter += 1
    }
    
    /// Generate data to send on Step 0 of session request.
    ///
    /// - Throws: Error generated on getting data from session object.
    private func getStep0Request() throws -> Data? {
        guard let publicKey = self.publicKey else {
            throw SecurityError.keygenError("Could not generate keypair")
        }
        var sessionData = SessionData()
        sessionData.secVer = .secScheme2
        sessionData.sec2.msg = .s2SessionCommand0
        sessionData.sec2.sc0.clientPubkey = publicKey
        sessionData.sec2.sc0.clientUsername = Data(username.utf8)
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
        sessionData.secVer = .secScheme2
        sessionData.sec2.msg = .s2SessionCommand1
        sessionData.sec2.sc1.clientProof = verifyData
        do {
            ESPLog.log("Serializing data")
            return try sessionData.serializedData()
        } catch {
            ESPLog.log("Cannot create handshake request 1")
            throw SecurityError.handshakeError("Cannot create handshake request 1")
        }
    }

    /// Processes data received as response of Step 0 request.
    ///
    /// - Parameter response: Step 0 response.
    /// - Throws: Security errors.
    private func processStep0Response(response: Data?) throws {
        guard let response = response else {
            ESPLog.log("Response 0 is nil.")
            throw SecurityError.handshakeError("Response 0 is nil")
        }
        let sessionData = try SessionData(serializedData: response)
        if sessionData.secVer != .secScheme2 {
            ESPLog.log("Security version mismatch.")
            throw SecurityError.handshakeError("Security version mismatch")
        }
        
        let devicePublicKey = sessionData.sec2.sr0.devicePubkey
        let deviceSalt = sessionData.sec2.sr0.deviceSalt
        do {
            let challengeResponse = try srp6a.processChallenge(salt: deviceSalt, publicKey: devicePublicKey)
            clientVerify = challengeResponse.clientVerify
            sessionKey = challengeResponse.sessionKey
        } catch {
            ESPLog.log(error.localizedDescription)
            throw error
        }
    }
    
    /// Processes data received as reponse of Step 1 request.
    ///
    /// - Parameter response: Step 1 response.
    /// - Throws: Security errors.
    private func processStep1Response(response: Data?) throws {
        if self.useCounter {
            guard let response = response else {
                ESPLog.log("Response 1 is nil")
                throw SecurityError.handshakeError("Response 1 is nil")
            }
            let sessionData = try SessionData(serializedData: response)
            if sessionData.secVer != .secScheme2 {
                ESPLog.log("Security version mismatch")
                throw SecurityError.handshakeError("Security version mismatch")
            }

            let deviceProof = sessionData.sec2.sr1.deviceProof
            
            // Store device nonce for IV generation
            self.deviceNonce = sessionData.sec2.sr1.deviceNonce
            
            // Initialize counter
            self.counter = 1
            
            do {
                try srp6a.verifySession(keyProof: deviceProof)
            } catch {
                throw error
            }
            
            if !srp6a.isAuthenticated {
                ESPLog.log("Authentication failed")
                throw SecurityError.handshakeError("Authentication failed")
            }
        } else {
            guard let response = response else {
                ESPLog.log("Response 1 is nil")
                throw SecurityError.handshakeError("Response 1 is nil")
            }
            let sessionData = try SessionData(serializedData: response)
            if sessionData.secVer != .secScheme2 {
                ESPLog.log("Security version mismatch")
                throw SecurityError.handshakeError("Security version mismatch")
            }
            
            let deviceProof = sessionData.sec2.sr1.deviceProof
            self.nonce = try AES.GCM.Nonce(data: sessionData.sec2.sr1.deviceNonce)
            do {
                try srp6a.verifySession(keyProof: deviceProof)
            } catch  {
                throw error
            }
            if !srp6a.isAuthenticated {
                ESPLog.log("Authentication failed")
                throw SecurityError.handshakeError("Authentication failed")
            }
        }
    }
}
