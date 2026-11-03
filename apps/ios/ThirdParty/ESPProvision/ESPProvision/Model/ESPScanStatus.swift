// Copyright 2022 Espressif Systems
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
//  ESPScanStatus.swift
//  ESPProvision
//

import Foundation

/// 'ESPScanStatus' defines intermediate stages of reading and processing QR code.
public enum ESPScanStatus {
    // QR Code scanning has started.
    case scanStarted
    // Parsing QR Code.
    case readingCode
    // Searching for BLE device with the name parsed from code.
    case searchingBLE(String)
    // Joining SoftAP network with the name parsed from code.
    case joiningSoftAP(String)
}
