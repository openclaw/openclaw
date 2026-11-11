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
//  ESPSoftAPTransport.swift
//  ESPProvision
//

import Foundation
import Network

import NetworkExtension

/// The `ESPSoftAPTransport` class conforms and implememnt methods of `ESPCommunicable` protocol.
/// This class provides methods for sending configuration and session related data to  `ESPDevice`.
public class ESPSoftAPTransport: ESPCommunicable {
    
    /// Instance of `ESPUtility`.
    var utility: ESPUtility
    var session:URLSession

    /// Stored cookies from Set-Cookie responses, sent on subsequent requests (matches Android EspLocalTransport behavior).
    private var storedCookieHeader: String?
    private let cookieLock = NSLock()

    /// Check device configuration status.
    ///
    /// - Returns: `Yes` if device is configured.
    func isDeviceConfigured() -> Bool {
        return true
    }

    /// URL fo sending data to device.
    var baseUrl: String

    /// Create HTTP implementation of Transport protocol
    ///
    /// - Parameter baseUrl: base URL for the HTTP endpoints
    public init(baseUrl: String) {
        self.baseUrl = baseUrl
        utility = ESPUtility()
        let config = URLSessionConfiguration.default
        config.allowsCellularAccess = false
        /// Use one connection per host so session handshake and next request (e.g. ch_resp) reuse the same TCP connection.
        config.httpMaximumConnectionsPerHost = 1
        session = URLSession(configuration: config)
    }

    /// Implementation of generic HTTP Request.
    /// Sends stored cookies on request and stores Set-Cookie from response (matching Android EspLocalTransport).
    ///
    /// - Parameters:
    ///   - path: Endpoint of base url.
    ///   - data: Data to be sent.
    ///   - completionHandler: Handler called when data is successfully sent and response is received.
    private func SendHTTPData(path: String, data: Data, completionHandler: @escaping (Data?, Error?) -> Swift.Void) {
        
        ESPLog.log("Sending HTTP data to device..")
        let url = URL(string: "http://\(baseUrl)/\(path)")!
        var request = URLRequest(url: url)

        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-type")
        request.setValue("text/plain", forHTTPHeaderField: "Accept")

        cookieLock.lock()
        if let cookie = storedCookieHeader, !cookie.isEmpty {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
            ESPLog.log("Sending Cookie header (session id from previous response)")
        }
        cookieLock.unlock()

        request.httpMethod = "POST"
        request.httpBody = data
        request.timeoutInterval = 30
        
        ESPLog.log("URLSession request initiated with data...\(data)")
        
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            ESPLog.log("Processing response..")
            guard let data = data, error == nil else {
                ESPLog.log("Error occured on HTTP request. Error: \(error.debugDescription)")
                completionHandler(nil, error)
                return
            }

            if let http = response as? HTTPURLResponse {
                if http.statusCode != 200 {
                    ESPLog.log("statusCode should be 200, but is \(http.statusCode)")
                }
                // Store Set-Cookie so next request (e.g. ch_resp) can send it (matches Android).
                for (key, value) in http.allHeaderFields {
                    if (key as? String)?.lowercased() == "set-cookie", let setCookies = value as? String, !setCookies.isEmpty {
                        guard let self = self else { return }
                        self.cookieLock.lock()
                        defer { self.cookieLock.unlock() }
                        self.storedCookieHeader = setCookies.components(separatedBy: ",").first?.trimmingCharacters(in: .whitespaces)
                        ESPLog.log("Stored Set-Cookie for future requests")
                        break
                    }
                }
            }
            ESPLog.log("HTTP request successful.")
            completionHandler(data, nil)
        }
        task.resume()
    }

    /// HTTP implementation of the Transport protocol.
    ///
    /// - Parameters:
    ///   - data: Data to be sent.
    ///   - sessionPath: Path for sending session related data.
    ///   - completionHandler: Handler called when data is successfully sent and response received.
    func SendSessionData(data: Data, sessionPath: String?, completionHandler: @escaping (Data?, Error?) -> Swift.Void) {
        ESPLog.log("Sending session data.")
        if let path = sessionPath {
            SendHTTPData(path: path, data: data, completionHandler: completionHandler)
        } else {
            SendHTTPData(path: "prov-session", data: data, completionHandler: completionHandler)
        }
    }

    /// HTTP implementation of the Transport protocol
    ///
    /// - Parameters:
    ///   - path: Endpoint of base url.
    ///   - data: Data to be sent.
    ///   - completionHandler: Handler called when data is successfully sent and response received.
    public func SendConfigData(path: String, data: Data, completionHandler: @escaping (Data?, Error?) -> Swift.Void) {
        ESPLog.log("Send config data to path \(path)")
        SendHTTPData(path: path, data: data, completionHandler: completionHandler)
    }

    func disconnect() {}
}
