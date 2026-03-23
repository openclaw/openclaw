import Foundation
import ImageIO
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

// MARK: - Generation Parameters

/// Stores all image generation settings for embedding in PNG tEXt metadata.
/// Compatible with ComfyUI-style metadata workflows.
public struct OpenClawImageGenParams: Codable, Sendable {
    /// Sentinel for identifying OpenClaw metadata in PNG Description field.
    public let _openclaw: Int

    public let prompt: String
    public let model: String
    public let resolution: String
    public let aspectRatio: String
    public let variations: Int

    /// Base64-encoded JPEG thumbnail of the input image (~200px wide), nil if none.
    public let inputImageThumbnail: String?
    public let inputImageMimeType: String?

    /// When the image was generated (ISO 8601).
    public let generatedAt: Date
    /// Schema version for forward compatibility.
    public let openclawVersion: String

    public init(
        prompt: String,
        model: String,
        resolution: String,
        aspectRatio: String,
        variations: Int,
        inputImageThumbnail: String? = nil,
        inputImageMimeType: String? = nil,
        generatedAt: Date = Date(),
        openclawVersion: String = "1"
    ) {
        self._openclaw = 1
        self.prompt = prompt
        self.model = model
        self.resolution = resolution
        self.aspectRatio = aspectRatio
        self.variations = variations
        self.inputImageThumbnail = inputImageThumbnail
        self.inputImageMimeType = inputImageMimeType
        self.generatedAt = generatedAt
        self.openclawVersion = openclawVersion
    }
}

// MARK: - Metadata Read/Write

public enum OpenClawImageMetadata {

    // MARK: Write

    /// Embed generation parameters into image data as a PNG tEXt "Description" chunk.
    /// If the source is JPEG, it is re-encoded as PNG. Returns nil on failure.
    public static func embedMetadata(into imageData: Data, params: OpenClawImageGenParams) -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        guard let jsonData = try? encoder.encode(params),
              let jsonString = String(data: jsonData, encoding: .utf8)
        else { return nil }

        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }

        let mutableData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            mutableData as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else { return nil }

        // Copy existing properties and inject our metadata into the PNG Description field
        let existingProps = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        var props = existingProps
        var pngDict = (props[kCGImagePropertyPNGDictionary] as? [CFString: Any]) ?? [:]
        pngDict[kCGImagePropertyPNGDescription] = jsonString
        props[kCGImagePropertyPNGDictionary] = pngDict

        CGImageDestinationAddImage(destination, cgImage, props as CFDictionary)

        guard CGImageDestinationFinalize(destination) else { return nil }
        return mutableData as Data
    }

    // MARK: Read

    /// Extract OpenClaw generation parameters from a PNG image's tEXt Description chunk.
    /// Returns nil if the image has no OpenClaw metadata or is not PNG.
    public static func extractMetadata(from imageData: Data) -> OpenClawImageGenParams? {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { return nil }

        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pngDict = properties[kCGImagePropertyPNGDictionary] as? [CFString: Any],
              let description = pngDict[kCGImagePropertyPNGDescription] as? String,
              description.contains("\"_openclaw\"")
        else { return nil }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = description.data(using: .utf8),
              let params = try? decoder.decode(OpenClawImageGenParams.self, from: data)
        else { return nil }

        return params
    }

    // MARK: Thumbnail

    /// Create a small JPEG thumbnail (~200px wide) from image data, returned as base64 string.
    public static func createThumbnail(from imageData: Data, maxWidth: Int = 200) -> String? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxWidth,
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }

        let jpegProps: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.6
        ]
        CGImageDestinationAddImage(dest, thumbnail, jpegProps as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }

        return (mutableData as Data).base64EncodedString()
    }
}
