import Foundation
import ImageIO
import OpenClawKit
import Testing

struct ShareImageProcessorTests {
    @Test func `downscales image larger than five megabytes and normalizes orientation`() throws {
        let input = try makeNoiseJPEGFixture(width: 3000, height: 2500, orientation: 6, quality: 1.0)
        try #require(input.count > ShareImageProcessor.maxPayloadBytes)

        let output = try ShareImageProcessor.processForUpload(data: input)
        #expect(output.count <= ShareImageProcessor.maxPayloadBytes)

        let source = try #require(CGImageSourceCreateWithData(output as CFData, nil))
        let properties = try #require(
            CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let width = try #require((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue)
        let height = try #require((properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue)
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1

        #expect(max(width, height) <= ShareImageProcessor.maxLongEdgePx)
        #expect(height > width)
        #expect(orientation == 1)
    }

    @Test func `reports invalid image`() {
        do {
            _ = try ShareImageProcessor.processForUpload(data: Data("not an image".utf8))
            Issue.record("Expected invalid-image error")
        } catch let error as ShareImageProcessor.ProcessError {
            #expect(error == .invalidImage)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}
