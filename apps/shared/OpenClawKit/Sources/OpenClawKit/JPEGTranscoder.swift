import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum JPEGTranscodeError: LocalizedError, Sendable {
    case decodeFailed
    case propertiesMissing
    case encodeFailed
    case sizeLimitExceeded(maxBytes: Int, actualBytes: Int)

    var errorDescription: String? {
        switch self {
        case .decodeFailed:
            "Failed to decode image data"
        case .propertiesMissing:
            "Failed to read image properties"
        case .encodeFailed:
            "Failed to encode image"
        case let .sizeLimitExceeded(maxBytes, actualBytes):
            "Image exceeds size limit (\(actualBytes) bytes > \(maxBytes) bytes)"
        }
    }
}

struct JPEGTranscoder: Sendable {
    static func clampQuality(_ quality: Double) -> Double {
        min(1.0, max(0.05, quality))
    }

    /// Re-encodes image data to JPEG, optionally downscaling so that the *oriented* pixel width is <= `maxWidthPx`.
    ///
    /// - Important: This normalizes EXIF orientation (the output pixels are rotated if needed; orientation tag is not
    ///   relied on).
    static func transcodeToJPEG(
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

    /// Re-encodes image data to JPEG, optionally downscaling so the *oriented* longest edge is <= `maxLongEdgePx`.
    ///
    /// When `maxLongEdgePx` is provided it takes precedence over `maxWidthPx`.
    /// - Important: This normalizes EXIF orientation (the output pixels are rotated if needed; orientation tag is not
    ///   relied on).
    static func transcodeToJPEG(
        imageData: Data,
        maxWidthPx: Int? = nil,
        maxLongEdgePx: Int?,
        quality: Double,
        maxBytes: Int? = nil) throws -> (data: Data, widthPx: Int, heightPx: Int)
    {
        try self.transcode(
            imageData: imageData,
            maxWidthPx: maxWidthPx,
            maxLongEdgePx: maxLongEdgePx,
            outputType: .jpeg,
            quality: quality,
            maxBytes: maxBytes)
    }

    /// Re-encodes image data to PNG, preserving alpha while normalizing orientation and stripping source metadata.
    static func transcodeToPNG(
        imageData: Data,
        maxLongEdgePx: Int?,
        maxBytes: Int? = nil) throws -> (data: Data, widthPx: Int, heightPx: Int)
    {
        try self.transcode(
            imageData: imageData,
            maxWidthPx: nil,
            maxLongEdgePx: maxLongEdgePx,
            outputType: .png,
            quality: nil,
            maxBytes: maxBytes)
    }

    private static func transcode(
        imageData: Data,
        maxWidthPx: Int?,
        maxLongEdgePx: Int?,
        outputType: UTType,
        quality: Double?,
        maxBytes: Int?) throws -> (data: Data, widthPx: Int, heightPx: Int)
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
            if let maxLongEdgePx, maxLongEdgePx > 0 {
                guard maxDim > maxLongEdgePx else { return maxDim } // never upscale
                return maxLongEdgePx
            }
            guard let maxWidthPx, maxWidthPx > 0 else { return maxDim }
            guard orientedWidth > maxWidthPx else { return maxDim } // never upscale

            let scale = Double(maxWidthPx) / Double(orientedWidth)
            return max(1, Int((Double(maxDim) * scale).rounded(.toNearestOrAwayFromZero)))
        }()

        func encode(maxPixelSize: Int, quality: Double?) throws -> (data: Data, widthPx: Int, heightPx: Int) {
            let thumbOpts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]

            guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else {
                throw JPEGTranscodeError.decodeFailed
            }
            let outputImage = outputType == .jpeg ? Self.flattenAlphaIfNeeded(img) : img

            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, outputType.identifier as CFString, 1, nil) else {
                throw JPEGTranscodeError.encodeFailed
            }
            let encodeProps: CFDictionary? = quality.map {
                [kCGImageDestinationLossyCompressionQuality: self.clampQuality($0)] as CFDictionary
            }
            CGImageDestinationAddImage(dest, outputImage, encodeProps)
            guard CGImageDestinationFinalize(dest) else {
                throw JPEGTranscodeError.encodeFailed
            }

            return (out as Data, outputImage.width, outputImage.height)
        }

        guard let maxBytes, maxBytes > 0 else {
            return try encode(maxPixelSize: targetMaxPixelSize, quality: quality)
        }

        let minPixelSize = 256
        var best = try encode(maxPixelSize: targetMaxPixelSize, quality: quality)
        if best.data.count <= maxBytes {
            return best
        }

        if quality == nil {
            for _ in 0..<6 {
                let nextPixelSize = max(Int(Double(targetMaxPixelSize) * 0.85), minPixelSize)
                if nextPixelSize == targetMaxPixelSize {
                    break
                }
                targetMaxPixelSize = nextPixelSize
                best = try encode(maxPixelSize: targetMaxPixelSize, quality: nil)
                if best.data.count <= maxBytes {
                    return best
                }
            }
            throw JPEGTranscodeError.sizeLimitExceeded(maxBytes: maxBytes, actualBytes: best.data.count)
        }

        let initialQuality = quality ?? 1
        let minQuality = max(0.2, self.clampQuality(initialQuality) * 0.35)
        for _ in 0..<6 {
            var q = self.clampQuality(initialQuality)
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

    /// JPEG cannot store alpha. Flatten transparent sources over white before encoding so ImageIO does not composite
    /// transparent pixels onto black by default.
    private static func flattenAlphaIfNeeded(_ image: CGImage) -> CGImage {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return image
        default:
            break
        }

        guard
            let context = CGContext(
                data: nil,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else {
            return image
        }

        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        return context.makeImage() ?? image
    }
}
