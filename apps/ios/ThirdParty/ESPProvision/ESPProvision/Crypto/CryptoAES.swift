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
//  MbedAES.swift
//  EspressifProvision
//

import CommonCrypto
import Foundation

class CryptoAES {
    var iv: Data
    var key: Data

    var streamBlock = Data()
    var nonceCounterOffset = 0
    var decryptor: AESDecryptor!

    public init(key: Data, iv: Data) {
        self.key = key
        self.iv = iv
        decryptor = AESDecryptor(key: key, iv: iv)
    }

    func encrypt(data: Data) -> Data? {
        var returnData: Data?
        var error: NSError?
        returnData = decryptor.cryptData(dataIn: data, operation: CCOperation(kCCEncrypt), mode: CCMode(kCCModeCTR), algorithm: CCAlgorithm(kCCAlgorithmAES), padding: CCPadding(ccNoPadding), keyLength: kCCKeySizeAES256, iv: iv, key: key, error: &error)
        return returnData
    }
}
