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
//  ESPTransport.swift
//  ESPProvision
//

import Foundation

/// Enum type representing errors encountered while communicating with `ESPDevice`.
enum ESPTransportError: Error {
    
    /// Device is not reachable or communication interrupted with device.
    case deviceUnreachableError(String)
    /// Error while communicating with device.
    case communicationError(Int)
}

/// Transport interface which abstracts the transport layer to send messages to the `ESPDevice`.
protocol ESPCommunicable {
    
    /// Instance of 'ESPUtility' class.
    var utility: ESPUtility { get }
    
    /// Send data related to session establishment.
    ///
    /// - Parameters:
    ///   - data: Data to be sent.
    ///   - sessionPath: Path for sending session related data.
    ///   - completionHandler: Handler called when data is successfully sent and response is received.
    func SendSessionData(data: Data, sessionPath: String?, completionHandler: @escaping (Data?, Error?) -> Swift.Void)

    /// Send data related to device configurations.
    ///
    /// - Parameters:
    ///   - path: Endpoint of base url.
    ///   - data: Config data to be sent.
    ///   - completionHandler: Handler called when data is successfully sent and response is received.
    func SendConfigData(path: String, data: Data, completionHandler: @escaping (Data?, Error?) -> Swift.Void)

    /// Check device configuration status.
    ///
    /// - Returns: `Yes` if device is configured.
    func isDeviceConfigured() -> Bool

    /// Disconnect `ESPDevice`.
    func disconnect()
}
