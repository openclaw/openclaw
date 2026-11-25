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
//  ESPSecurity0.swift
//  ESPProvision
//

import Foundation

/// Enum type which encapsulates different states of a session.
enum Security0SessionState: Int {
    /// Initial state of a session.
    case State0
    /// State of session after first response is received.
    case State1
}

/// The `ESPSecurity0` class conforms and implememnt methods of `ESPCodeable` protocol.
/// This class provides methods for handling request/response data in an unsecured manner.
class ESPSecurity0: ESPCodeable {
    
    /// Store the session state.
    var sessionState: Security0SessionState = .State0
    
    /// Get the next request based upon the current session,
    /// state and the response data passed to this function
    ///
    /// - Parameter data: Data that was received in the previous step.
    /// - Returns: Data to be sent in the next step.
    /// - Throws: Security errors.
    func getNextRequestInSession(data: Data?) throws -> Data? {
        
        ESPLog.log("Getting next request in session...")
        
        var response: Data?
        do {
            switch sessionState {
            case .State0:
                sessionState = .State1
                response = try getStep0Request()!
            case .State1:
                try processStep0Response(response: data)
            }
        } catch {
            response = nil
        }

        return response
    }

    /// Send unsecured data.
    ///
    /// - Parameter data: Data to be sent.
    /// - Returns: Unencrypted version as communication is not secure.
    func encrypt(data: Data) -> Data? {
        
        ESPLog.log("Encrypted data security 0.")
        
        return data
    }
    
    /// Send unsecured data.
    ///
    /// - Parameter data: Data from device.
    /// - Returns: Data as received in the argument.
    func decrypt(data: Data) -> Data? {
        
        ESPLog.log("Decrypted data security 0.")

        return data
    }

    /// Generate data to send on Step 0 of session request.
    ///
    /// - Throws: Error generated on getting data from session object.
    private func getStep0Request() throws -> Data? {
        
        ESPLog.log("Generating Step 0 request data...")

        var request: Data?
        var sessionData = SessionData()
        sessionData.secVer = .secScheme0
        do {
            try sessionData.sec0.sc.merge(serializedData: S0SessionCmd().serializedData())
            request = try? sessionData.serializedData()
        } catch {
            ESPLog.log("Serializing Step0 request throws error.")
            throw error
        }

        return request
    }

    /// Processes data received as reponse of Step 0 request.
    ///
    /// - Parameter response: Step 0 response.
    /// - Throws: Security errors.
    private func processStep0Response(response: Data?) throws {
        
        ESPLog.log("Processing Step0 response...")

        guard let response = response else {
            ESPLog.log("Response is nil.")
            throw SecurityError.handshakeError("Response is nil")
        }
        
        ESPLog.log("Serializing Step0 response.")
        let sessionData = try SessionData(serializedData: response)
        if sessionData.secVer != .secScheme0 {
            ESPLog.log("Security version mismatch.")
            throw SecurityError.handshakeError("Security version mismatch")
        }
    }
}
