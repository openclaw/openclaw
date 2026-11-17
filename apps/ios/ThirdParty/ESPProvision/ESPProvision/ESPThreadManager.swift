// Copyright 2024 Espressif Systems
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
//  ESPThreadManager.swift
//  ESPProvision
//

import Foundation

/// `ESPScanWifiListProtocol` provides Wi-Fi scan result to conforming class.
protocol ESPScanThreadListProtocol {
    func threadScanFinished(threadList: [ESPThreadNetwork]?, error: ESPThreadScanError?)
}

/// The `ESPWiFiManager` class manages methods related with Wi-Fi scanning and processing.
class ESPThreadManager {
    private let transport: ESPCommunicable
    private let security: ESPCodeable
    private var scanResult: [String: ThreadScanResult] = [:]

    var delegate: ESPScanThreadListProtocol?

    /// Initialise Wi-Fi manager instance.
    ///
    /// - Parameter session: Session associated with `ESPDevice`.
    init(session: ESPSession) {
        transport = session.transportLayer
        security = session.securityLayer
    }

    /// Send command to `ESPDevice` to start scanning for available Wi-Fi networks.
    func startThreadScan() {
        do {
            let payloadData = try createStartScanRequest()
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error!))
                        return
                    }
                    self.processStartScan(responseData: response!)
                    self.getThreadScanStatus()
                }
            } else {
                delegate?.threadScanFinished(threadList: nil, error: .emptyConfigData)
            }
        } catch {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
        }
    }

    private func processStartScan(responseData: Data) {
        guard let decryptedResponse = security.decrypt(data: responseData) else {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(ESPSessionError.encryptionError))
            return
        }
        do {
            _ = try NetworkScanPayload(serializedData: decryptedResponse)
        } catch {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
        }
    }

    private func getThreadScanStatus() {
        do {
            let payloadData = try createThreadScanConfigRequest()
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error!))
                        return
                    }
                    let scanCount = self.processGetThreadScanStatus(responseData: response!)
                    if scanCount > 0 {
                        self.getScannedThreadListResponse(count: scanCount)
                    } else {
                        self.delegate?.threadScanFinished(threadList: nil, error: .emptyResultCount)
                    }
                }
            }
        } catch {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
        }
    }

    func processGetThreadScanStatus(responseData: Data) -> UInt32 {
        let resultCount: UInt32 = 0
        if let decryptedResponse = security.decrypt(data: responseData) {
            do {
                let payload = try NetworkScanPayload(serializedData: decryptedResponse)
                let response = payload.respScanThreadStatus
                return response.resultCount
            } catch {
                delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
            }
        }
        return resultCount
    }

    func getScannedThreadListResponse(count: UInt32, startIndex: UInt32 = 0) {
        do {
            var lastFetch = false
            var fetchCount: UInt32 = 4
            if startIndex + 4 >= count {
                fetchCount = count - startIndex
                lastFetch = true
            }
            let payloadData = try createThreadListConfigRequest(startIndex: startIndex, count: fetchCount)
            if let data = payloadData {
                transport.SendConfigData(path: transport.utility.scanPath, data: data) { response, error in
                    guard error == nil, response != nil else {
                        self.delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error!))
                        return
                    }
                    self.getScannedThreadNetworks(response: response!, fetchFinish: lastFetch)
                    if startIndex + fetchCount < count {
                        self.getScannedThreadListResponse(count: count, startIndex: startIndex + 4)
                    }
                }
            } else {
                delegate?.threadScanFinished(threadList: nil, error: .emptyConfigData)
            }
        } catch {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
        }
    }

    private func getScannedThreadNetworks(response: Data, fetchFinish: Bool) {
        do {
            if let decryptedResponse = try security.decrypt(data: response) {
                let payload = try NetworkScanPayload(serializedData: decryptedResponse)
                let responseList = payload.respScanThreadResult
                for index in 0 ... responseList.entries.count - 1 {
                    let networkName = responseList.entries[index].networkName
                    scanResult[networkName] = responseList.entries[index]
                }
                if fetchFinish {
                    var threadList:[ESPThreadNetwork] = []
                    for item in [ThreadScanResult](scanResult.values) {
                        let threadNetwork = ESPThreadNetwork(panID: item.panID, channel: item.channel, rssi: item.rssi, lqi: item.lqi, extAddr: item.extAddr, networkName: item.networkName, extPanID: item.extPanID)
                        threadList.append(threadNetwork)
                    }
                    if threadList.isEmpty {
                        delegate?.threadScanFinished(threadList: nil, error: nil)
                    } else {
                        delegate?.threadScanFinished(threadList: threadList, error: nil)
                    }
                }
            }
        } catch {
            delegate?.threadScanFinished(threadList: nil, error: .scanRequestError(error))
        }
    }

    private func createStartScanRequest() throws -> Data? {
        var configRequest = CmdScanThreadStart()
        configRequest.blocking = true
        configRequest.channelMask = 0
        let msgType = NetworkScanMsgType.typeCmdScanThreadStart
        var payload = NetworkScanPayload()
        payload.msg = msgType
        payload.cmdScanThreadStart = configRequest
        return try security.encrypt(data: payload.serializedData())
    }

    private func createThreadScanConfigRequest() throws -> Data? {
        let configRequest = CmdScanThreadStatus()
        let msgType = NetworkScanMsgType.typeCmdScanThreadStatus
        var payload = NetworkScanPayload()
        payload.msg = msgType
        payload.cmdScanThreadStatus = configRequest
        return try security.encrypt(data: payload.serializedData())
    }

    private func createThreadListConfigRequest(startIndex: UInt32, count: UInt32) throws -> Data? {
        var configRequest = CmdScanThreadResult()
        configRequest.startIndex = startIndex
        configRequest.count = count
        var payload = NetworkScanPayload()
        payload.msg = NetworkScanMsgType.typeCmdScanThreadResult
        payload.cmdScanThreadResult = configRequest
        return try security.encrypt(data: payload.serializedData())
    }
}


