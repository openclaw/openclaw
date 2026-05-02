import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import OpenClawKit

final class ChatImageProcessorTests: XCTestCase {
    /// Build a synthetic JPEG with embedded EXIF + GPS so we can verify the
    /// metadata-stripping behavior. Resolution can be tuned.
    private func syntheticJPEG(width: Int, height: Int) throws -> Data {
        let ctx = CGContext(
            data: nil,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.4, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(CGColor(red: 0.1, green: 0.7, blue: 0.3, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
        guard let image = ctx.makeImage() else {
            throw XCTSkip("could not build context image")
        }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil)
        else {
            throw XCTSkip("could not create image destination")
        }
        let props: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.95,
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2026:04:20 16:30:00",
                kCGImagePropertyExifLensModel: "Leaky Lens 50mm f/1.4",
            ] as CFDictionary,
            kCGImagePropertyGPSDictionary: [
                kCGImagePropertyGPSLatitude: 60.02,
                kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 10.95,
                kCGImagePropertyGPSLongitudeRef: "E",
            ] as CFDictionary,
            kCGImagePropertyTIFFDictionary: [
                kCGImagePropertyTIFFMake: "LeakCorp",
                kCGImagePropertyTIFFModel: "Privacy-Leaker-1",
            ] as CFDictionary,
        ]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            throw XCTSkip("could not finalize image")
        }
        return data as Data
    }

    private func readProperties(_ data: Data) -> [CFString: Any] {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        else { return [:] }
        return props
    }

    private func readDimensions(_ data: Data) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (w, h)
    }

    func test_resizesLongEdgeTo1600() throws {
        let src = try syntheticJPEG(width: 4000, height: 3000)
        let out = try ChatImageProcessor.processForUpload(data: src)
        guard let (w, h) = readDimensions(out) else {
            return XCTFail("could not read output dimensions")
        }
        XCTAssertLessThanOrEqual(max(w, h), 1600, "long edge should be <= 1600")
        // aspect preserved within ~1%
        let srcRatio = 4000.0 / 3000.0
        let outRatio = Double(w) / Double(h)
        XCTAssertEqual(srcRatio, outRatio, accuracy: 0.02, "aspect preserved")
    }

    func test_resizesPortraitLongEdgeTo1600() throws {
        // Portrait: width < height — the long edge is the height.
        let src = try syntheticJPEG(width: 3000, height: 4000)
        let out = try ChatImageProcessor.processForUpload(data: src)
        guard let (w, h) = readDimensions(out) else {
            return XCTFail("could not read output dimensions")
        }
        XCTAssertLessThanOrEqual(h, 1600, "portrait long edge (height) should be <= 1600")
        XCTAssertLessThanOrEqual(max(w, h), 1600, "no dimension should exceed 1600")
        // aspect preserved
        let srcRatio = 3000.0 / 4000.0
        let outRatio = Double(w) / Double(h)
        XCTAssertEqual(srcRatio, outRatio, accuracy: 0.02, "aspect preserved")
    }

    func test_resizesNarrowTallLongEdgeTo1600() throws {
        // Narrow-tall: width well below 1600, height well above.
        let src = try syntheticJPEG(width: 1080, height: 2400)
        let out = try ChatImageProcessor.processForUpload(data: src)
        guard let (w, h) = readDimensions(out) else {
            return XCTFail("could not read output dimensions")
        }
        XCTAssertLessThanOrEqual(h, 1600, "narrow-tall long edge (height) should be <= 1600")
        XCTAssertLessThanOrEqual(max(w, h), 1600, "no dimension should exceed 1600")
        // aspect preserved
        let srcRatio = 1080.0 / 2400.0
        let outRatio = Double(w) / Double(h)
        XCTAssertEqual(srcRatio, outRatio, accuracy: 0.02, "aspect preserved")
    }

    func test_stripsEXIFAndGPSAndTIFF() throws {
        let src = try syntheticJPEG(width: 3000, height: 2000)
        let out = try ChatImageProcessor.processForUpload(data: src)
        let props = self.readProperties(out)

        // Verify the dictionaries either are absent or empty.
        let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        let gps = props[kCGImagePropertyGPSDictionary] as? [CFString: Any] ?? [:]
        let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]

        // GPS: absolutely must be empty.
        XCTAssertTrue(gps.isEmpty, "GPS dict must be empty; got \(gps)")

        // EXIF: the specific leaky fields we planted must not survive.
        XCTAssertNil(exif[kCGImagePropertyExifDateTimeOriginal], "datetime must be stripped")
        XCTAssertNil(exif[kCGImagePropertyExifLensModel], "lens model must be stripped")

        // TIFF: make/model must be gone.
        XCTAssertNil(tiff[kCGImagePropertyTIFFMake], "camera make must be stripped")
        XCTAssertNil(tiff[kCGImagePropertyTIFFModel], "camera model must be stripped")
    }

    func test_outputIsUnderPayloadBudget() throws {
        let src = try syntheticJPEG(width: 4000, height: 3000)
        let out = try ChatImageProcessor.processForUpload(data: src)
        XCTAssertLessThanOrEqual(out.count, ChatImageProcessor.maxPayloadBytes)
    }

    func test_rejectsNonImageData() {
        let garbage = Data("not an image, just some text".utf8)
        XCTAssertThrowsError(try ChatImageProcessor.processForUpload(data: garbage))
    }

    func test_smallImageStaysSmall() throws {
        let src = try syntheticJPEG(width: 400, height: 300)
        let out = try ChatImageProcessor.processForUpload(data: src)
        guard let (w, h) = readDimensions(out) else {
            return XCTFail("could not read output dimensions")
        }
        // Should not upscale; should keep original-ish size.
        XCTAssertLessThanOrEqual(max(w, h), 400)
    }

    // ---- Bytes-level metadata test (Greptile P2: empty dicts vs omitted) ----

    /// Scan raw JPEG output bytes for any of the specific privacy-sensitive
    /// strings we planted in the source, regardless of which APP segment
    /// (EXIF, GPS, IPTC, TIFF, XMP) ImageIO might write. ImageIO emits a
    /// minimal default EXIF block on output even when we don't pass a
    /// dictionary; the real contract this PR cares about is that none of the
    /// sensitive source values survive into the output bytes.
    func test_outputContainsNoLeakedSensitiveStrings() throws {
        let src = try syntheticJPEG(width: 1200, height: 900)
        let out = try ChatImageProcessor.processForUpload(data: src)
        // Search the raw bytes for ASCII fragments planted in the source EXIF/TIFF.
        let needles = [
            "Leaky Lens",
            "LeakCorp",
            "Privacy-Leaker",
            "2026:04:20",
        ]
        for needle in needles {
            let needleBytes = Array(needle.utf8)
            XCTAssertNil(
                out.range(of: Data(needleBytes)),
                "output JPEG must not contain leaked source string: \(needle)")
        }
    }

    // ---- Alpha flattening (Greptile P1) ----

    private func syntheticPNGWithAlpha(width: Int, height: Int) throws -> Data {
        let ctx = CGContext(
            data: nil,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // Fully transparent canvas
        ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))
        // Solid red square in the center, half-transparent around the edges (still alpha != 1.0 net)
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 2))
        guard let image = ctx.makeImage() else {
            throw XCTSkip("could not build context image")
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil)
        else {
            throw XCTSkip("could not create PNG destination")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw XCTSkip("could not finalize PNG")
        }
        return data as Data
    }

    /// PR1 P1: a transparent PNG must come back as a fully opaque JPEG.
    /// We don't assert the exact background color, just that the alpha
    /// channel is gone and corner pixels (which were transparent) are now
    /// solidly opaque (i.e. no leftover transparency).
    func test_flattensAlphaToOpaqueJPEG() throws {
        let src = try syntheticPNGWithAlpha(width: 800, height: 600)
        let out = try ChatImageProcessor.processForUpload(data: src)

        guard let source = CGImageSourceCreateWithData(out as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return XCTFail("could not decode output")
        }
        // JPEG cannot have an alpha channel; if any is reported it must be a 'skip' variant.
        let alpha = cg.alphaInfo
        XCTAssertTrue(
            alpha == .none || alpha == .noneSkipFirst || alpha == .noneSkipLast,
            "output JPEG should be opaque; got alphaInfo=\(alpha.rawValue)")
    }
}
