import AppKit
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct ScreenSnapshotEncodingTests {
    @Test(arguments: [OpenClawScreenSnapshotFormat.jpeg, .png])
    func capturedFramePreservesFormatAndMetadata(format: OpenClawScreenSnapshotFormat) throws {
        let context = try #require(CGContext(
            data: nil,
            width: 6,
            height: 4,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 6, height: 4))
        let image = try #require(context.makeImage())
        let frame = ScreenSnapshotService.CapturedFrame(image: image, displayFrameId: "fixture-frame")
        let result = try ScreenSnapshotService.encodeFrame(frame, format, 0.8)
        #expect(result.format == format)
        #expect(result.width == 6)
        #expect(result.height == 4)
        #expect(result.displayFrameId == "fixture-frame")
        let decoded = try #require(NSBitmapImageRep(data: result.data))
        #expect(decoded.pixelsWide == 6)
        #expect(decoded.pixelsHigh == 4)
        let signature: [UInt8] = format == .jpeg ? [0xFF, 0xD8] : [0x89, 0x50]
        #expect(Array(result.data.prefix(2)) == signature)
    }
}
