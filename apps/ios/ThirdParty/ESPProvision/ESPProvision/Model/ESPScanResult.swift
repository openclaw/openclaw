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
//  ESPScanResult.swift
//  ESPProvision
//

import Foundation

enum ESPScanError: Error {
    case invalidQRCode
}

struct ESPScanResult: Decodable {
    var name: String
    var username: String?
    var pop: String?
    var security: ESPSecurity
    var transport: ESPTransport
    var password: String?
    var network: ESPNetworkType?
    
    enum CodingKeys: String, CodingKey {
        case name
        case username
        case pop
        case security
        case transport
        case password
        case network
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        pop = try container.decodeIfPresent(String.self, forKey: .pop)
        let tp = try container.decode(String.self, forKey: .transport)
        security = try ESPSecurity.init(rawValue: container.decodeIfPresent(Int.self, forKey: .security) ?? 2)
        if security == .secure2 {
            username = try container.decodeIfPresent(String.self, forKey: .username)
        }
        if let transportValue = try ESPTransport.init(rawValue: container.decode(String.self, forKey: .transport)) {
            transport = transportValue
        } else {
            throw ESPScanError.invalidQRCode
        }
        password = try container.decodeIfPresent(String.self, forKey: .password)
        if let networkType = try? container.decodeIfPresent(String.self, forKey: .network) {
            network = ESPNetworkType(rawValue: networkType)
        }
    }
}
