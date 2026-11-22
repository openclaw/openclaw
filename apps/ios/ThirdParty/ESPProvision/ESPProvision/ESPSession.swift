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
//  Session.swift
//  EspressifProvision
//

import Foundation

/// The `ESPSession` class contains information related with session configuration.
/// Provides method to establish session with a device for communication.
class ESPSession {
    
    private var transportLayerPrivate: ESPCommunicable
    private var securityLayerPrivate: ESPCodeable

    /// Get current transport layer of session.
    var transportLayer: ESPCommunicable {
        return transportLayerPrivate
    }
    
    /// Get current security layer of session.
    var securityLayer: ESPCodeable {
        return securityLayerPrivate
    }

    private var isSessionEstablished: Bool

    /// Flag which indicates if the session has been successfully established.
    var isEstablished: Bool {
        return isSessionEstablished
    }

    /// Create a session object with the given Transport and Security implementations.
    /// Session object is used for establishing a secure connection with the device before
    /// provisioning.
    ///
    /// - Parameters:
    ///   - transport: Mode of transport.
    ///   - security: Mode of secure data transmission.
    init(transport: ESPCommunicable, security: ESPCodeable) {
        ESPLog.log("Initialising session class with transport: \(transport) and security: \(security)")
        transportLayerPrivate = transport
        securityLayerPrivate = security
        isSessionEstablished = false
    }

    /// Initialize the session handshake to establish a secure session with the device.
    ///
    /// - Parameters:
    ///   - response: Response received from the device.
    ///   - sessionPath: Path for sending session related data.
    ///   - completionHandler: Handler called when the session establishment completes.
    func initialize(response: Data?, sessionPath: String?, completionHandler: @escaping (Error?) -> Swift.Void) {
        
        ESPLog.log("Initializing the session handshake to establish a secure session with the device.")
        do {
            let request = try securityLayerPrivate.getNextRequestInSession(data: response)
            ESPLog.log("session intialize")
            if let request = request {
                transportLayerPrivate.SendSessionData(data: request, sessionPath: sessionPath) { responseData, error in
                    
                    guard error == nil else {
                        ESPLog.log("Session error: \(error.debugDescription)")
                        completionHandler(error)
                        return
                    }
                    
                    ESPLog.log("Received response.")
                    if let responseData = responseData {
                        self.initialize(response: responseData, sessionPath: sessionPath,
                                        completionHandler: completionHandler)
                    } else {
                        ESPLog.log("Session establishment failed.")
                        completionHandler(SecurityError.handshakeError("Session establish failed"))
                    }
                }
            } else {
                isSessionEstablished = true
                completionHandler(nil)
            }
        } catch {
            completionHandler(error)
        }
    }
}
