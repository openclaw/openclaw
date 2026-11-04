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
//  ESPThreadNetwork.swift
//  ESPProvision
//
//

import Foundation
import SwiftProtobuf

/// Type that represent a single Wi-Fi network.
/// Array of this object is returned when scan Wi-Fi command is given to ESPDevice.
public struct ESPThreadNetwork {

    public var panID: UInt32 = 0

    public var channel: UInt32 = 0

    public var rssi: Int32 = 0

    public var lqi: UInt32 = 0

    public var extAddr: Data = Data()

    public var networkName: String = String()

    public var extPanID: Data = Data()
}
