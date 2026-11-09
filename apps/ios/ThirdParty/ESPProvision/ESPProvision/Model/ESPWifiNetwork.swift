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
//  ESPWifiNetwork.swift
//  ESPProvision
//
//

import Foundation
import SwiftProtobuf

/// Type that represent a single Wi-Fi network.
/// Array of this object is returned when scan Wi-Fi command is given to ESPDevice.
public struct ESPWifiNetwork {

    /// The name of wireless network.
    public var ssid: String = ""
    /// The numbers of Wi-Fi channel.
    public var channel: UInt32 = 0
    /// Number indicating the signal strength of wireless network.
    public var rssi: Int32 = 0
    /// The mac address of wireless network.
    public var bssid: Data = SwiftProtobuf.Internal.emptyData
    /// The authorisation mode of wireless network.
    public var auth: WifiAuthMode = .open
    /// Contains uncategorized additional info of wireless network.
    public var unknownFields = SwiftProtobuf.UnknownStorage()
}
