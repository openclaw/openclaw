import AppKit
import Darwin
import OpenClawKit
import os
import Testing
@testable import OpenClaw

@MainActor
struct ScreenSnapshotEncodingTests {
    @Test(arguments: [OpenClawScreenSnapshotFormat.jpeg, .png])
    func snapshotEncodesOffMainThread(format: OpenClawScreenSnapshotFormat) async throws {
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
        let encoderThreads = OSAllocatedUnfairLock(initialState: [Bool]())
        var captureCalls = 0
        let service = ScreenSnapshotService(
            capture: { screenIndex, maxWidth in
                captureCalls += 1
                #expect(screenIndex == 2)
                #expect(maxWidth == 123)
                return ScreenSnapshotService.CapturedFrame(image: image, displayFrameId: "fixture-frame")
            },
            encode: { frame, selectedFormat, quality in
                encoderThreads.withLock { $0.append(pthread_main_np() != 0) }
                #expect(selectedFormat == format)
                #expect(quality == 0.8)
                // Real production encoder, not manufactured bytes or a simulated executor.
                return try ScreenSnapshotService.encodeFrame(frame, selectedFormat, quality)
            })

        #expect(pthread_main_np() != 0)
        let result = try await service.snapshot(screenIndex: 2, maxWidth: 123, quality: 0.8, format: format)
        #expect(captureCalls == 1)
        #expect(encoderThreads.withLock { $0 } == [false])
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
