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
//  ESPWiFiManager.swift
//  ESPProvision
//

import Foundation

/// `ESPScanWifiListProtocol` provides Wi-Fi scan result to conforming class.
protocol ESPScanWifiListProtocol {
    func wifiScanFinished(wifiList: [ESPWifiNetwork]?, error: ESPWiFiScanError?)
}

/// The `ESPWiFiManager` class manages methods related with Wi-Fi scanning and processing.
class ESPWiFiManager {
    private let transport: ESPCommunicable
    private let security: ESPCodeable
    private var scanResult: [String: WiFiScanResult] = [:]

    var delegate: ESPScanWifiListProtocol?

    /// Initialise Wi-Fi manager instance.
    ///
    /// - Parameter session: Session associated with `ESPDevice`.
    init(session: ESPSession) {
        transport = session.transportLayer
        security = session.securityLayer
    }

    /// Send command to `ESPDevice` to start scanning for available Wi-Fi networks.
    func startWifiScan() {
        do {
            let payloadData = try createStartScanRequest()
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error!))
                        return
                    }
                    self.processStartScan(responseData: response!)
                    self.getWiFiScanStatus()
                }
            } else {
                delegate?.wifiScanFinished(wifiList: nil, error: .emptyConfigData)
            }
        } catch {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
        }
    }

    private func processStartScan(responseData: Data) {
        guard let decryptedResponse = security.decrypt(data: responseData) else {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(ESPSessionError.encryptionError))
            return
        }
        do {
            _ = try NetworkScanPayload(serializedData: decryptedResponse)
        } catch {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
        }
    }

    private func getWiFiScanStatus() {
        do {
            let payloadData = try createWifiScanConfigRequest()
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error!))
                        return
                    }
                    let scanCount = self.processGetWiFiScanStatus(responseData: response!)
                    if scanCount > 0 {
                        self.getScannedWiFiListResponse(count: scanCount)
                    } else {
                        self.delegate?.wifiScanFinished(wifiList: nil, error: .emptyResultCount)
                    }
                }
            }
        } catch {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
        }
    }

    func processGetWiFiScanStatus(responseData: Data) -> UInt32 {
        let resultCount: UInt32 = 0
        if let decryptedResponse = security.decrypt(data: responseData) {
            do {
                let payload = try NetworkScanPayload(serializedData: decryptedResponse)
                let response = payload.respScanWifiStatus
                return response.resultCount
            } catch {
                delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
            }
        }
        return resultCount
    }

    func getScannedWiFiListResponse(count: UInt32, startIndex: UInt32 = 0) {
        do {
            var lastFetch = false
            var fetchCount: UInt32 = 4
            if startIndex + 4 >= count {
                fetchCount = count - startIndex
                lastFetch = true
            }
            let payloadData = try createWifiListConfigRequest(startIndex: startIndex, count: fetchCount)
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error!))
                        return
                    }
                    self.getScannedWifiSSIDs(response: response!, fetchFinish: lastFetch)
                    if startIndex + fetchCount < count {
                        self.getScannedWiFiListResponse(count: count, startIndex: startIndex + 4)
                    }
                }
            } else {
                delegate?.wifiScanFinished(wifiList: nil, error: .emptyConfigData)
            }
        } catch {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
        }
    }

    private func getScannedWifiSSIDs(response: Data, fetchFinish: Bool) {
        do {
            if let decryptedResponse = try security.decrypt(data: response) {
                let payload = try NetworkScanPayload(serializedData: decryptedResponse)
                let responseList = payload.respScanWifiResult
                for index in 0 ... responseList.entries.count - 1 {
                    let ssid = String(decoding: responseList.entries[index].ssid, as: UTF8.self)
                    let rssi = responseList.entries[index].rssi
                    if let val = scanResult[ssid] {
                        if rssi > val.rssi {
                            scanResult[ssid] = val
                        }
                    } else {
                        scanResult[ssid] = responseList.entries[index]
                    }
                }
                if fetchFinish {
                    var wifiList:[ESPWifiNetwork] = []
                        for item in [WiFiScanResult](scanResult.values) {
                            let wifiNetwork = ESPWifiNetwork(ssid: String(decoding: item.ssid, as: UTF8.self), channel: item.channel, rssi: item.rssi, bssid: item.bssid, auth: item.auth, unknownFields: item.unknownFields)
                            wifiList.append(wifiNetwork)
                        }
                    if wifiList.isEmpty {
                        delegate?.wifiScanFinished(wifiList: nil, error: nil)
                    } else {
                        delegate?.wifiScanFinished(wifiList: wifiList, error: nil)
                    }
                }
            }
        } catch {
            delegate?.wifiScanFinished(wifiList: nil, error: .scanRequestError(error))
        }
    }

    private func createStartScanRequest() throws -> Data? {
        var configRequest = CmdScanWifiStart()
        configRequest.blocking = true
        configRequest.passive = false
        configRequest.groupChannels = 0
        configRequest.periodMs = 120
        let msgType = NetworkScanMsgType.typeCmdScanWifiStart
        var payload = NetworkScanPayload()
        payload.msg = msgType
        payload.cmdScanWifiStart = configRequest
        return try security.encrypt(data: payload.serializedData())
    }

    private func createWifiScanConfigRequest() throws -> Data? {
        var configRequest = CmdScanWifiStatus()
        let msgType = NetworkScanMsgType.typeCmdScanWifiStatus
        var payload = NetworkScanPayload()
        payload.msg = msgType
        payload.cmdScanWifiStatus = configRequest
        return try security.encrypt(data: payload.serializedData())
    }

    private func createWifiListConfigRequest(startIndex: UInt32, count: UInt32) throws -> Data? {
        var configRequest = CmdScanWifiResult()
        configRequest.startIndex = startIndex
        configRequest.count = count
        var payload = NetworkScanPayload()
        payload.msg = NetworkScanMsgType.typeCmdScanWifiResult
        payload.cmdScanWifiResult = configRequest
        return try security.encrypt(data: payload.serializedData())
    }

    /// Send command to `ESPDevice` to reset Wi-Fi status.
    ///
    /// - Parameter completionHandler: The completion handler that is called when reset command is sent.
    ///                                Parameter of block include status of the operation or error if any.
    func resetWifiStatus(completionHandler: @escaping (Status?, Error?) -> Void) {
        do {
            let payloadData = try createResetWifiRequest()
            if let data = payloadData {
                let path = transport.utility.ctrlPath
                transport.SendConfigData(path: path, data: data) { response, error in
                    guard error == nil, response != nil else {
                        completionHandler(nil, error)
                        return
                    }
                    let status = self.processResetWifiResponse(responseData: response!)
                    completionHandler(status, nil)
                }
            } else {
                let error = NSError(domain: "ESPWiFiManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to create reset request"])
                completionHandler(nil, error)
            }
        } catch {
            completionHandler(nil, error)
        }
    }

    private func processResetWifiResponse(responseData: Data) -> Status? {
        if let decryptedResponse = security.decrypt(data: responseData) {
            do {
                let payload = try NetworkCtrlPayload(serializedData: decryptedResponse)
                return payload.status
            } catch {
                return nil
            }
        }
        return nil
    }

    private func createResetWifiRequest() throws -> Data? {
        let configRequest = CmdCtrlWifiReset()
        let msgType = NetworkCtrlMsgType.typeCmdCtrlWifiReset
        var payload = NetworkCtrlPayload()
        payload.msg = msgType
        payload.cmdCtrlWifiReset = configRequest
        return try security.encrypt(data: payload.serializedData())
    }
}
