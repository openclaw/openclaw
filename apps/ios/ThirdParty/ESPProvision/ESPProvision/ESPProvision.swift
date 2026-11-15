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
//  ESPProvision.swift
//  ESPProvision
//

import Foundation
import UIKit

/// Provision class which exposes the main API for provisioning
/// the device with Wifi credentials.
public class ESPProvision {
    private let session: ESPSession
    private let transportLayer: ESPCommunicable
    private let securityLayer: ESPCodeable
    var wifiConnectedIp4Addr: String? = nil

    public static let CONFIG_TRANSPORT_KEY = "transport"
    public static let CONFIG_SECURITY_KEY = "security1"
    public static let CONFIG_PROOF_OF_POSSESSION_KEY = "proofOfPossession"
    public static let CONFIG_BASE_URL_KEY = "baseUrl"
    public static let CONFIG_WIFI_AP_KEY = "wifiAPPrefix"

    public static let CONFIG_TRANSPORT_WIFI = "wifi"
    public static let CONFIG_TRANSPORT_BLE = "ble"
    public static let CONFIG_SECURITY_SECURITY0 = "security0"
    public static let CONFIG_SECURITY_SECURITY1 = "security1"

    /// Create Provision object with a Session object
    /// Here the Provision class will require a session
    /// which has been successfully initialised by calling Session.initialize
    ///
    /// - Parameter session: Initialised session object
    init(session: ESPSession) {
        ESPLog.log("Initialising provision class.")
        self.session = session
        transportLayer = session.transportLayer
        securityLayer = session.securityLayer
    }
    
    /// Send Configuration information relating to the Home
    /// Wifi network which the device should use for Internet access

    ///
    /// - Parameters:
    ///   - ssid: ssid of the home network
    ///   - passphrase: passphrase
    ///   - completionHandler: handler called when config data is sent
    func configureNetwork(ssid: String?,
                          passphrase: String?,
                          threadOperationalDataset: Data? = nil,
                          completionHandler: @escaping (Status, Error?) -> Swift.Void) {
        ESPLog.log("Sending configuration info of home network to device.")
        if session.isEstablished {
            do {
                let message = try createSetNetworkConfigRequest(ssid: ssid, passphrase: passphrase, threadOperationalDataset: threadOperationalDataset)
                if let message = message {
                    transportLayer.SendConfigData(path: transportLayer.utility.configPath, data: message) { response, error in
                        guard error == nil, response != nil else {
                            ESPLog.log("Error while sending config data error: \(error.debugDescription)")
                            completionHandler(Status.internalError, error)
                            return
                        }
                        ESPLog.log("Received response.")
                        if let _ = threadOperationalDataset {
                            let status = self.processSetThreadConfigResponse(response: response)
                            completionHandler(status, nil)
                        } else {
                            let status = self.processSetWifiConfigResponse(response: response)
                            completionHandler(status, nil)
                        }
                    }
                }
            } catch {
                ESPLog.log("Error while creating config request error: \(error.localizedDescription)")
                completionHandler(Status.internalError, error)
            }
        }
    }

    /// Apply all current configurations on the device.
    /// A typical flow will be
    /// Initialize session -> Set config (1 or more times) -> Apply config
    /// This API call will also start a poll for getting Wifi connection status from the device
    ///
    /// - Parameters:
    ///   - completionHandler: handler to be called when apply config message is sent
    ///   - wifiStatusUpdatedHandler: handler to be called when wifi status is updated on the device
    func applyConfigurations(completionHandler: @escaping (Status, Error?) -> Void,
                             wifiStatusUpdatedHandler: @escaping (WifiStationState, WifiConnectFailedReason, Error?) -> Void) {
        ESPLog.log("Applying Wi-Fi configuration...")
        if session.isEstablished {
            do {
                let message = try createApplyConfigRequest()
                if let message = message {
                    transportLayer.SendConfigData(path: transportLayer.utility.configPath, data: message) { response, error in
                        guard error == nil, response != nil else {
                            ESPLog.log("Error while applying Wi-Fi configuration: \(error.debugDescription)")
                            completionHandler(Status.internalError, error)
                            return
                        }
                        ESPLog.log("Received response.")
                        let status = self.processApplyConfigResponse(response: response)
                        completionHandler(status, nil)
                        self.pollForWifiConnectionStatus { wifiStatus, failReason, error in
                            wifiStatusUpdatedHandler(wifiStatus, failReason, error)
                        }
                    }
                }
            } catch {
                ESPLog.log("Error while creating configuration request: \(error.localizedDescription)")
                completionHandler(Status.internalError, error)
            }
        }
    }

    private func pollForWifiConnectionStatus(completionHandler: @escaping (WifiStationState, WifiConnectFailedReason, Error?) -> Swift.Void) {
        do {
            ESPLog.log("Start polling for Wi-Fi connection status...")
            let message = try createGetWifiConfigRequest()
            if let message = message {
                transportLayer.SendConfigData(path: transportLayer.utility.configPath,
                                         data: message) { response, error in
                    guard error == nil, response != nil else {
                        ESPLog.log("Error on polling request: \(error.debugDescription)")
                        completionHandler(WifiStationState.disconnected, WifiConnectFailedReason.UNRECOGNIZED(0), error)
                        return
                    }
                    
                    ESPLog.log("Response received.")
                    do {
                        let (stationState, failReason) = try
                            self.processGetWifiConfigStatusResponse(response: response)
                        if stationState == .connected {
                            ESPLog.log("Status: connected.")
                            completionHandler(stationState, WifiConnectFailedReason.UNRECOGNIZED(0), nil)
                        } else if stationState == .connecting {
                            ESPLog.log("Status: connecting.")
                            sleep(5)
                            self.pollForWifiConnectionStatus(completionHandler: completionHandler)
                        } else {
                            ESPLog.log("Status: failed.")
                            completionHandler(stationState, failReason, nil)
                        }
                    } catch {
                        ESPLog.log("Error while processing response: \(error.localizedDescription)")
                        completionHandler(WifiStationState.disconnected, WifiConnectFailedReason.UNRECOGNIZED(0), error)
                    }
                }
            }
        } catch {
            ESPLog.log("Error while creating polling request: \(error.localizedDescription)")
            completionHandler(WifiStationState.connectionFailed, WifiConnectFailedReason.UNRECOGNIZED(0), error)
        }
    }

    private func createSetNetworkConfigRequest(ssid: String?, passphrase: String?, threadOperationalDataset: Data? = nil) throws -> Data? {
        ESPLog.log("Create set Wi-Fi config request.")
        var configData = NetworkConfigPayload()
        configData.msg = NetworkConfigMsgType.typeCmdSetWifiConfig
        if let ssid = ssid {
            configData.cmdSetWifiConfig.ssid = Data(ssid.bytes)
        }
        if let passphrase = passphrase {
            configData.cmdSetWifiConfig.passphrase = Data(passphrase.bytes)
        }
        if let threadOperationalDataset = threadOperationalDataset {
            configData.msg = NetworkConfigMsgType.typeCmdSetThreadConfig
            configData.cmdSetThreadConfig.dataset = threadOperationalDataset
        }
        return try securityLayer.encrypt(data: configData.serializedData())
    }

    private func createApplyConfigRequest() throws -> Data? {
        ESPLog.log("Create apply config request.")
        var configData = NetworkConfigPayload()
        configData.cmdApplyWifiConfig = CmdApplyWifiConfig()
        configData.msg = NetworkConfigMsgType.typeCmdApplyWifiConfig
        return try securityLayer.encrypt(data: configData.serializedData())
    }
    
    private func createGetWifiConfigRequest() throws -> Data? {
        ESPLog.log("Create get Wi-Fi config request.")
        var configData = NetworkConfigPayload()
        configData.cmdGetWifiStatus = CmdGetWifiStatus()
        configData.msg = NetworkConfigMsgType.typeCmdGetWifiStatus
        return try securityLayer.encrypt(data: configData.serializedData())
    }
    
    private func processSetWifiConfigResponse(response: Data?) -> Status {
        ESPLog.log("Process set Wi-Fi config response.")
        guard let response = response else {
            return Status.invalidArgument
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt set Wi-Fi config response.")
            return Status.invalidArgument
        }
        var responseStatus: Status = .invalidArgument
        do {
            let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
            responseStatus = configResponse.respGetWifiStatus.status
        } catch {
            ESPLog.log(error.localizedDescription)
        }
        return responseStatus
    }

    private func processApplyConfigResponse(response: Data?) -> Status {
        ESPLog.log("Process apply Wi-Fi config response.")
        guard let response = response else {
            return Status.invalidArgument
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt apply Wi-Fi config response.")
            return Status.invalidArgument
        }
        var responseStatus: Status = .invalidArgument
        do {
            let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
            responseStatus = configResponse.respApplyWifiConfig.status
        } catch {
            ESPLog.log(error.localizedDescription)
        }
        return responseStatus
    }

    private func processGetWifiConfigStatusResponse(response: Data?) throws -> (WifiStationState, WifiConnectFailedReason) {
        ESPLog.log("Process get Wi-Fi config status response.")
        guard let response = response else {
            return (WifiStationState.disconnected, WifiConnectFailedReason.UNRECOGNIZED(-1))
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt get Wi-Fi status response.")
            return (WifiStationState.disconnected, WifiConnectFailedReason.UNRECOGNIZED(-1))
        }
        var responseStatus = WifiStationState.disconnected
        var failReason = WifiConnectFailedReason.UNRECOGNIZED(-1)
        let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
        responseStatus = configResponse.respGetWifiStatus.wifiStaState
        failReason = configResponse.respGetWifiStatus.wifiFailReason
        
        if (responseStatus == .connected){
            self.wifiConnectedIp4Addr = configResponse.respGetWifiStatus.wifiConnected.ip4Addr
        }

        return (responseStatus, failReason)
    }
    
    //MARK: Thread APIs
    private func createGetThreadConfigRequest() throws -> Data? {
        ESPLog.log("Create get Wi-Fi config request.")
        var configData = NetworkConfigPayload()
        configData.cmdGetThreadStatus = CmdGetThreadStatus()
        configData.msg = NetworkConfigMsgType.typeCmdGetThreadStatus

        return try securityLayer.encrypt(data: configData.serializedData())
    }
    
    private func createApplyThreadConfigRequest() throws -> Data? {
        ESPLog.log("Create apply config request.")
        var configData = NetworkConfigPayload()
        configData.cmdApplyThreadConfig = CmdApplyThreadConfig()
        configData.msg = NetworkConfigMsgType.typeCmdApplyThreadConfig
        return try securityLayer.encrypt(data: configData.serializedData())
    }

    private func processSetThreadConfigResponse(response: Data?) -> Status {
        ESPLog.log("Process set Wi-Fi config response.")
        guard let response = response else {
            return Status.invalidArgument
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt set Thread config response.")
            return Status.invalidArgument
        }
        var responseStatus: Status = .invalidArgument
        do {
            let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
            responseStatus = configResponse.respGetThreadStatus.status
        } catch {
            ESPLog.log(error.localizedDescription)
        }
        return responseStatus
    }
    
    private func pollForThreadConnectionStatus(completionHandler: @escaping (ThreadNetworkState, ThreadAttachFailedReason, Error?) -> Swift.Void) {
        do {
            ESPLog.log("Start polling for Wi-Fi connection status...")
            let message = try createGetThreadConfigRequest()
            if let message = message {
                transportLayer.SendConfigData(path: transportLayer.utility.configPath,
                                         data: message) { response, error in
                    guard error == nil, response != nil else {
                        ESPLog.log("Error on polling request: \(error.debugDescription)")
                        completionHandler(ThreadNetworkState.dettached, ThreadAttachFailedReason.UNRECOGNIZED(0), error)
                        return
                    }
                    
                    ESPLog.log("Response received.")
                    do {
                        let (stationState, failReason) = try
                            self.processGetThreadConfigStatusResponse(response: response)
                        if stationState == .attached {
                            ESPLog.log("Status: connected.")
                            completionHandler(stationState, ThreadAttachFailedReason.UNRECOGNIZED(0), nil)
                        } else if stationState == .attaching {
                            ESPLog.log("Status: connecting.")
                            sleep(5)
                            self.pollForThreadConnectionStatus(completionHandler: completionHandler)
                        } else {
                            ESPLog.log("Status: failed.")
                            completionHandler(stationState, failReason, nil)
                        }
                    } catch {
                        ESPLog.log("Error while processing response: \(error.localizedDescription)")
                        completionHandler(ThreadNetworkState.dettached, ThreadAttachFailedReason.UNRECOGNIZED(0), error)
                    }
                }
            }
        } catch {
            ESPLog.log("Error while creating polling request: \(error.localizedDescription)")
            completionHandler(ThreadNetworkState.attachingFailed, ThreadAttachFailedReason.UNRECOGNIZED(0), error)
        }
    }
    
    private func processGetThreadConfigStatusResponse(response: Data?) throws -> (ThreadNetworkState, ThreadAttachFailedReason) {
        ESPLog.log("Process get Wi-Fi config status response.")
        guard let response = response else {
            return (ThreadNetworkState.dettached, ThreadAttachFailedReason.UNRECOGNIZED(-1))
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt get Thread status response.")
            return (ThreadNetworkState.dettached, ThreadAttachFailedReason.UNRECOGNIZED(-1))
        }
        var responseStatus = ThreadNetworkState.dettached
        var failReason = ThreadAttachFailedReason.UNRECOGNIZED(-1)
        let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
        responseStatus = configResponse.respGetThreadStatus.threadState
        failReason = configResponse.respGetThreadStatus.threadFailReason
        
        if (responseStatus == .attached){
            self.wifiConnectedIp4Addr = configResponse.respGetThreadStatus.threadAttached.name
        }

        return (responseStatus, failReason)
    }
    
    private func processApplyThreadConfigResponse(response: Data?) -> Status {
        ESPLog.log("Process apply Thread config response.")
        guard let response = response else {
            return Status.invalidArgument
        }

        guard let decryptedResponse = securityLayer.decrypt(data: response) else {
            ESPLog.log("Failed to decrypt apply Thread config response.")
            return Status.invalidArgument
        }
        var responseStatus: Status = .invalidArgument
        do {
            let configResponse = try NetworkConfigPayload(serializedData: decryptedResponse)
            responseStatus = configResponse.respApplyThreadConfig.status
        } catch {
            ESPLog.log(error.localizedDescription)
        }
        return responseStatus
    }
    
    /// Apply all current configurations on the device.
    /// A typical flow will be
    /// Initialize session -> Set config (1 or more times) -> Apply config
    /// This API call will also start a poll for getting Wifi connection status from the device
    ///
    /// - Parameters:
    ///   - completionHandler: handler to be called when apply config message is sent
    ///   - wifiStatusUpdatedHandler: handler to be called when wifi status is updated on the device
    func applyThreadConfigurations(completionHandler: @escaping (Status, Error?) -> Void,
                                   threadStatusUpdatedHandler: @escaping (ThreadNetworkState, ThreadAttachFailedReason, Error?) -> Void) {
        ESPLog.log("Applying Wi-Fi configuration...")
        if session.isEstablished {
            do {
                let message = try createApplyThreadConfigRequest()
                if let message = message {
                    transportLayer.SendConfigData(path: transportLayer.utility.configPath, data: message) { response, error in
                        guard error == nil, response != nil else {
                            ESPLog.log("Error while applying Wi-Fi configuration: \(error.debugDescription)")
                            completionHandler(Status.internalError, error)
                            return
                        }
                        ESPLog.log("Received response.")
                        let status = self.processApplyConfigResponse(response: response)
                        completionHandler(status, nil)
                        self.pollForThreadConnectionStatus { threadStatus, failReason, error in
                            threadStatusUpdatedHandler(threadStatus, failReason, error)
                        }
                    }
                }
            } catch {
                ESPLog.log("Error while creating configuration request: \(error.localizedDescription)")
                completionHandler(Status.internalError, error)
            }
        }
    }
}

