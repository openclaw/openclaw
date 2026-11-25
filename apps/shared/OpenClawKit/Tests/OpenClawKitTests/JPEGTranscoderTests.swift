import CoreGraphics
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import OpenClawKit

struct JPEGTranscoderTests {
    private func makeSolidJPEG(width: Int, height: Int, orientation: Int? = nil) throws -> Data {
        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard
            let ctx = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: cs,
                bitmapInfo: bitmapInfo)
        else {
            throw NSError(domain: "JPEGTranscoderTests", code: 1)
        }

        ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let img = ctx.makeImage() else {
            throw NSError(domain: "JPEGTranscoderTests", code: 5)
        }

        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw NSError(domain: "JPEGTranscoderTests", code: 2)
        }

        var props: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 1.0,
        ]
        if let orientation {
            props[kCGImagePropertyOrientation] = orientation
        }

        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "JPEGTranscoderTests", code: 3)
        }

        return out as Data
    }

    @Test func `downscales to max width px`() throws {
        let input = try makeSolidJPEG(width: 2000, height: 1000)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 1600)
        #expect(abs(out.heightPx - 800) <= 1)
        #expect(!out.data.isEmpty)
    }

    @Test func `does not upscale when smaller than max width px`() throws {
        let input = try makeSolidJPEG(width: 800, height: 600)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 800)
        #expect(out.heightPx == 600)
    }

    @Test func `normalizes orientation and uses oriented width for max width px`() throws {
        // Encode a landscape image but mark it rotated 90° (orientation 6). Oriented width becomes 1000.
        let input = try makeSolidJPEG(width: 2000, height: 1000, orientation: 6)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 1000)
        #expect(out.heightPx == 2000)
    }

    @Test func `respects max bytes`() throws {
        let input = try makeNoiseJPEGFixture(width: 1600, height: 1200)
        let uncapped = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.95)
        try #require(uncapped.data.count > 180_000)
        let out = try JPEGTranscoder.transcodeToJPEG(
            imageData: input,
            maxWidthPx: 1600,
            quality: 0.95,
            maxBytes: 180_000)
        #expect(out.data.count <= 180_000)
    }

    @Test func `explicitly fails when size limit cannot be met`() throws {
        let input = try makeSolidJPEG(width: 800, height: 600)

        do {
            _ = try JPEGTranscoder.transcodeToJPEG(
                imageData: input,
                maxWidthPx: 800,
                quality: 0.9,
                maxBytes: 1)
            Issue.record("Expected a size-limit error")
        } catch let JPEGTranscodeError.sizeLimitExceeded(maxBytes, actualBytes) {
            #expect(maxBytes == 1)
            #expect(actualBytes > maxBytes)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}
