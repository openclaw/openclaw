// Copyright 2023 Espressif Systems
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
//  AppDelegate.swift
//  ESPProvisionSample
//

import CommonCrypto
import Foundation

class AESDecryptor {
    var cryptor: CCCryptorRef?
    var ccStatus: CCCryptorStatus = 0
    
    init(key: Data, iv: Data) {
        cryptor = nil
        
        ccStatus = CCCryptorCreateWithMode(
            CCOperation(kCCEncrypt),
            CCMode(kCCModeCTR),
            CCAlgorithm(kCCAlgorithmAES),
            CCPadding(ccNoPadding),
            iv.bytes, key.bytes,
            key.count,
            nil, 0, 0, // tweak XTS mode, numRounds
            CCModeOptions(kCCModeOptionCTR_BE),
            &cryptor)
    }
    
    
    func cryptData(dataIn: Data,
                   operation: CCOperation,  // kCC Encrypt, Decrypt
                   mode: CCMode,            // kCCMode ECB, CBC, CFB, CTR, OFB, RC4, CFB8
                   algorithm: CCAlgorithm,  // CCAlgorithm AES DES, 3DES, CAST, RC4, RC2, Blowfish
                   padding: CCPadding,      // cc NoPadding, PKCS7Padding
                   keyLength: size_t,       // kCCKeySizeAES 128, 192, 256
                   iv: Data,            // CBC, CFB, CFB8, OFB, CTR
                   key: Data,
                   error: inout NSError?) -> Data?
    {
        // Check that the key length is correct
        if (key.count != keyLength) {
            if (error != nil) {
                error = NSError(domain: "kArgumentError key length", code: key.count, userInfo: nil)
            }
            return nil
        }
        
        var dataOutMoved: size_t = 0
        var dataOutMovedTotal: size_t = 0
        var ccStatus: CCCryptorStatus = 0
        
        // Get the output buffer size
        let dataOutLength = CCCryptorGetOutputLength(cryptor, dataIn.count, true)
        // Allocate the output buffer
        var dataOut = NSMutableData(length: dataOutLength)!
        let dataOutPointer = dataOut.mutableBytes.assumingMemoryBound(to: CChar.self)
        
        // Encrypt or decrypt the input data
        ccStatus = CCCryptorUpdate(
            cryptor!,
            dataIn.bytes, dataIn.count,
            dataOutPointer, dataOutLength,
            &dataOutMoved)
        dataOutMovedTotal += dataOutMoved
        
        if ccStatus != kCCSuccess {
            if error != nil {
                error = NSError(domain: "kUpdateError", code: Int(ccStatus), userInfo: nil)
            }
            CCCryptorRelease(cryptor!)
            return nil
        }
        
        // Finalize the encryption or decryption
        ccStatus = CCCryptorFinal(
            cryptor!,
            dataOutPointer + dataOutMoved, dataOutLength - dataOutMoved,
            &dataOutMoved)
        if ccStatus != kCCSuccess {
            if error != nil {
                error = NSError(domain: "kFinalError", code: Int(ccStatus), userInfo: nil)
            }
            CCCryptorRelease(cryptor!)
            return nil
        }
        
        dataOutMovedTotal += dataOutMoved
        dataOut.length = dataOutMovedTotal
        
        return (dataOut as Data)
    }
    
    /**
     Copies the contents of an array of elements starting at a specified index to an UnsafeMutableRawPointer.
     
     - Parameters:
        - to: An UnsafeMutableRawPointer to which the elements will be copied.
        - from: An array of elements to copy.
        - startIndexAtPointer: The starting index in bytes at which to copy the elements to the destination pointer.
     */
    func copyMemoryStartingAtIndex<T>(to umrp: UnsafeMutableRawPointer, from arr: [T], startIndexAtPointer toIndex: Int) {
        // Calculate the byte offset from the destination pointer based on the starting index.
        let byteOffset = MemoryLayout<T>.stride * toIndex
        // Calculate the total number of bytes that need to be copied based on the size of each element in the array.
        let byteCount = MemoryLayout<T>.stride * arr.count
        
        // Use the `copyMemory` method of the destination pointer to copy the bytes from the source array to the destination pointer.
        // The `advanced(by:)` method is used to move the pointer to the correct starting index before copying.
        umrp.advanced(by: byteOffset).copyMemory(from: arr, byteCount: byteCount)
    }
}
