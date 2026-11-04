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
//  HexUtils.swift
//  EspressifProvision
//

import Foundation

struct HexUtils {
    static func xor(first: Data, second: Data) -> Data {
        let firstBytes = [UInt8](first)
        let secondBytes = [UInt8](second)

        let maxLength = max(firstBytes.count, secondBytes.count)
        var output = [UInt8].init(repeating: 0, count: maxLength)
        for i in 0 ..< maxLength {
            output[i] = firstBytes[i % firstBytes.count] ^ secondBytes[i % secondBytes.count]
        }

        return Data(output)
    }
}

extension Data {
    struct HexEncodingOptions: OptionSet {
        let rawValue: Int
        static let upperCase = HexEncodingOptions(rawValue: 1 << 0)
    }

    func hexEncodedString(options: HexEncodingOptions = []) -> String {
        let format = options.contains(.upperCase) ? "%02hhX" : "%02hhx"
        return map { String(format: format, $0) }.joined()
    }
}
