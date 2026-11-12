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
//  ESPUtility.swift
//  ESPProvision
//

import CoreBluetooth
import Foundation
import UIKit

/// The 'ESPUtility' class store and manages necessary information related to Transport layer.
class ESPUtility {
    
    /// The base url for sending HTTP request to softAp ESPDevice.
    static let baseUrl = Bundle.main.infoDictionary?[ESPConstants.wifiBaseUrl] as? String ?? ESPConstants.wifiBaseUrlDefault
    
    /// The path used for sending configuration related data to ESPDevice.
    var configPath: String = ESPConstants.configPath
    /// The path used for fetching ESPDevice versions and other informations.
    var versionPath: String = ESPConstants.versionPath
    /// The path used for giving scan Wi-Fi scan command to ESPDevice and fetching related information.
    var scanPath: String = ESPConstants.scanPath
    /// The path used to esptablish session with an ESPDevice.
    var sessionPath: String = ESPConstants.sessionPath
    /// The path used for sending network control commands to ESPDevice.
    var ctrlPath: String = ESPConstants.ctrlPath
    /// Flag indicating configuration status of peripheral device.
    var peripheralConfigured = false
    /// Store session characterisitic of connected ble device.
    var sessionCharacteristic: CBCharacteristic!
    /// Stores path and associated charactersitic in dictionary format.
    var configUUIDMap: [String: CBCharacteristic] = [:]
    /// Stores device version information.
    var deviceVersionInfo: NSDictionary?
    
    /// Process and store descriptor values read from BLE devices.
    ///
    /// - Parameter descriptor: The CBDescriptor of a BLE characteristic.
    func processDescriptor(descriptor: CBDescriptor) {
        if let value = descriptor.value as? String {
            if value.contains(ESPConstants.sessionPath) {
                peripheralConfigured = true
                sessionCharacteristic = descriptor.characteristic
            }
            if let associatedCharacteristic = descriptor.characteristic {
                configUUIDMap.updateValue(associatedCharacteristic, forKey: value)
            }
        }
    }
}
