import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

func makeNoiseJPEGFixture(
    width: Int,
    height: Int,
    orientation: Int? = nil,
    quality: Double? = nil) throws -> Data
{
    let bytesPerPixel = 4
    var pixels = Data(count: width * height * bytesPerPixel)
    return try pixels.withUnsafeMutableBytes { buffer -> Data in
        var state: UInt64 = 0x1234_5678_9ABC_DEF0
        // SplitMix64 fills eight deterministic noise bytes per step, without per-byte system randomness.
        for offset in stride(from: 0, to: buffer.count, by: MemoryLayout<UInt64>.size) {
            state &+= 0x9E37_79B9_7F4A_7C15
            var word = state
            word = (word ^ (word >> 30)) &* 0xBF58_476D_1CE4_E5B9
            word = (word ^ (word >> 27)) &* 0x94D0_49BB_1331_11EB
            word ^= word >> 31
            if buffer.count - offset >= MemoryLayout<UInt64>.size {
                buffer.storeBytes(of: word.littleEndian, toByteOffset: offset, as: UInt64.self)
            } else {
                for index in offset..<buffer.count {
                    buffer[index] = UInt8(truncatingIfNeeded: word)
                    word >>= 8
                }
            }
        }

        let context = try #require(CGContext(
            data: buffer.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * bytesPerPixel,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil))
        var properties: [CFString: Any] = [:]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        if let quality { properties[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        try #require(CGImageDestinationFinalize(destination))
        return output as Data
    }
}
