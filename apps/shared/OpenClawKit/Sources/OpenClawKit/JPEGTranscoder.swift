import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum JPEGTranscodeError: LocalizedError, Sendable {
    case decodeFailed
    case propertiesMissing
    case encodeFailed
    case sizeLimitExceeded(maxBytes: Int, actualBytes: Int)

    public var errorDescription: String? {
        switch self {
        case .decodeFailed:
            "Failed to decode image data"
        case .propertiesMissing:
            "Failed to read image properties"
        case .encodeFailed:
            "Failed to encode JPEG"
        case let .sizeLimitExceeded(maxBytes, actualBytes):
            "JPEG exceeds size limit (\(actualBytes) bytes > \(maxBytes) bytes)"
        }
    }
}

public struct JPEGTranscoder: Sendable {
    public static func clampQuality(_ quality: Double) -> Double {
        min(1.0, max(0.05, quality))
    }

    /// Re-encodes image data to JPEG, optionally downscaling so that the *oriented* pixel width is <= `maxWidthPx`.
    ///
    /// - Important: This normalizes EXIF orientation (the output pixels are rotated if needed; orientation tag is not
    ///   relied on).
    public static func transcodeToJPEG(
        imageData: Data,
        maxWidthPx: Int?,
        quality: Double,
        maxBytes: Int? = nil) throws -> (data: Data, widthPx: Int, heightPx: Int)
    {
        try self.transcodeToJPEG(
            imageData: imageData,
            maxWidthPx: maxWidthPx,
            maxLongEdgePx: nil,
            quality: quality,
            maxBytes: maxBytes)
    }

    /// Re-encodes image data to JPEG, optionally downscaling so that the *oriented* longest edge is <= `maxLongEdgePx`.
    ///
    /// When `maxLongEdgePx` is provided it takes precedence over `maxWidthPx`.
    /// - Important: This normalizes EXIF orientation (the output pixels are rotated if needed; orientation tag is not
    ///   relied on).
    public static func transcodeToJPEG(
        imageData: Data,
        maxWidthPx: Int? = nil,
        maxLongEdgePx: Int?,
        quality: Double,
        maxBytes: Int? = nil) throws -> (data: Data, widthPx: Int, heightPx: Int)
    {
        guard let src = CGImageSourceCreateWithData(imageData as CFData, nil) else {
            throw JPEGTranscodeError.decodeFailed
        }
        guard
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
            let rawWidth = props[kCGImagePropertyPixelWidth] as? NSNumber,
            let rawHeight = props[kCGImagePropertyPixelHeight] as? NSNumber
        else {
            throw JPEGTranscodeError.propertiesMissing
        }

        let pixelWidth = rawWidth.intValue
        let pixelHeight = rawHeight.intValue
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1

        guard pixelWidth > 0, pixelHeight > 0 else {
            throw JPEGTranscodeError.propertiesMissing
        }

        let rotates90 = orientation == 5 || orientation == 6 || orientation == 7 || orientation == 8
        let orientedWidth = rotates90 ? pixelHeight : pixelWidth
        let orientedHeight = rotates90 ? pixelWidth : pixelHeight

        let maxDim = max(orientedWidth, orientedHeight)
        var targetMaxPixelSize: Int = {
            // maxLongEdgePx takes precedence: cap the longest edge directly.
            if let maxLongEdgePx, maxLongEdgePx > 0 {
                guard maxDim > maxLongEdgePx else { return maxDim } // never upscale
                return maxLongEdgePx
            }
            guard let maxWidthPx, maxWidthPx > 0 else { return maxDim }
            guard orientedWidth > maxWidthPx else { return maxDim } // never upscale

            let scale = Double(maxWidthPx) / Double(orientedWidth)
            return max(1, Int((Double(maxDim) * scale).rounded(.toNearestOrAwayFromZero)))
        }()

        func encode(maxPixelSize: Int, quality: Double) throws -> (data: Data, widthPx: Int, heightPx: Int) {
            let thumbOpts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]

            guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else {
                throw JPEGTranscodeError.decodeFailed
            }

            // JPEG cannot carry an alpha channel. If the decoded thumbnail has
            // one, draw it onto an opaque white background before encode so a
            // transparent PNG/HEIC source doesn't gain a black background from
            // ImageIO's default composite. White is the safer chat default.
            let opaque = Self.flattenAlphaIfNeeded(img)

            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw JPEGTranscodeError.encodeFailed
            }
            let q = self.clampQuality(quality)
            let encodeProps = [kCGImageDestinationLossyCompressionQuality: q] as CFDictionary
            CGImageDestinationAddImage(dest, opaque, encodeProps)
            guard CGImageDestinationFinalize(dest) else {
                throw JPEGTranscodeError.encodeFailed
            }

            return (out as Data, opaque.width, opaque.height)
        }

        guard let maxBytes, maxBytes > 0 else {
            return try encode(maxPixelSize: targetMaxPixelSize, quality: quality)
        }

        let minQuality = max(0.2, self.clampQuality(quality) * 0.35)
        let minPixelSize = 256
        var best = try encode(maxPixelSize: targetMaxPixelSize, quality: quality)
        if best.data.count <= maxBytes {
            return best
        }

        for _ in 0..<6 {
            var q = self.clampQuality(quality)
            for _ in 0..<6 {
                let candidate = try encode(maxPixelSize: targetMaxPixelSize, quality: q)
                best = candidate
                if candidate.data.count <= maxBytes {
                    return candidate
                }
                if q <= minQuality { break }
                q = max(minQuality, q * 0.75)
            }

            let nextPixelSize = max(Int(Double(targetMaxPixelSize) * 0.85), minPixelSize)
            if nextPixelSize == targetMaxPixelSize {
                break
            }
            targetMaxPixelSize = nextPixelSize
        }

        if best.data.count > maxBytes {
            throw JPEGTranscodeError.sizeLimitExceeded(maxBytes: maxBytes, actualBytes: best.data.count)
        }

        return best
    }

    /// JPEG cannot store an alpha channel; without flattening, ImageIO
    /// composites transparent regions against black on encode, which is
    /// almost never what a chat or capture flow wants. Returns `image`
    /// unchanged when the alpha info is already opaque or skip-style.
    private static func flattenAlphaIfNeeded(_ image: CGImage) -> CGImage {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return image
        default:
            break
        }
        let width = image.width
        let height = image.height
        guard let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) else {
            return image
        }
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else {
            return image
        }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage() ?? image
    }
}
