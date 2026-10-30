import OpenClawKit
import Photos
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
final class PhotoLibraryServiceTests: XCTestCase {
    /// Run on a disposable simulator with Photos access; delete the simulator after the run.
    func testLatestReturnsRequestedPhotosBeyondTheOldBatchBudget() async throws {
        guard ProcessInfo.processInfo.environment["OPENCLAW_IOS_PHOTOS_INTEGRATION"] == "1" else {
            throw XCTSkip("Requires an isolated photo library and Photos permission")
        }
        XCTAssertTrue(PhotoLibraryAccess.canRead(PhotoLibraryAccess.authorizationStatus()))

        let imageData = try Self.makePhoto()
        let library = PHPhotoLibrary.shared()
        try library.performChangesAndWait {
            for index in 0..<20 {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: imageData, options: nil)
                request.creationDate = Date.distantFuture.addingTimeInterval(Double(index))
            }
        }
        for limit in [2, 20] {
            let payload = try await PhotoLibraryService().latest(
                params: OpenClawPhotosLatestParams(limit: limit, maxWidth: 1600, quality: 0.8))
            XCTAssertEqual(payload.photos.count, limit)
            XCTAssertGreaterThan(payload.photos.reduce(0) { $0 + $1.base64.count }, 340 * 1024)
            XCTAssertLessThan(try JSONEncoder().encode(payload).count, 16 * 1024 * 1024)
        }
    }

    private static func makePhoto() throws -> Data {
        let width = 1600
        var seed: UInt32 = 1
        var pixels = [UInt8](repeating: 255, count: width * width * 4)
        for offset in stride(from: 0, to: pixels.count, by: 4) {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            pixels[offset] = UInt8(truncatingIfNeeded: seed >> 24)
            pixels[offset + 1] = UInt8(truncatingIfNeeded: seed >> 16)
            pixels[offset + 2] = UInt8(truncatingIfNeeded: seed >> 8)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try XCTUnwrap(CGImage(
            width: width,
            height: width,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent))
        return try XCTUnwrap(UIImage(cgImage: image).pngData())
    }
}
