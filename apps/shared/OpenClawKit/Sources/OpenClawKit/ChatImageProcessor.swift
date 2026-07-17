import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum ImageUploadFormat: Sendable, Equatable {
    case jpeg
    case png

    public var fileExtension: String {
        switch self {
        case .jpeg: "jpg"
        case .png: "png"
        }
    }

    public var mimeType: String {
        switch self {
        case .jpeg: "image/jpeg"
        case .png: "image/png"
        }
    }

    public static func detect(data: Data) -> Self? {
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let typeIdentifier = CGImageSourceGetType(source)
        else {
            return nil
        }
        return switch typeIdentifier as String {
        case UTType.jpeg.identifier: .jpeg
        case UTType.png.identifier: .png
        default: nil
        }
    }
}

/// Chat-specific image upload policy built on the shared image transcoder.
public enum ChatImageProcessor {
    public static let maxLongEdgePx = 1600
    public static let jpegQuality = 0.8
    public static let maxPayloadBytes = 3_500_000

    public enum ProcessError: Error, LocalizedError, Sendable {
        case notAnImage
        case decodeFailed
        case encodeFailed

        public var errorDescription: String? {
            switch self {
            case .notAnImage:
                "The data is not a recognizable image."
            case .decodeFailed:
                "The image could not be decoded."
            case .encodeFailed:
                "The image could not be resized to fit the chat upload limit."
            }
        }
    }

    public static func processForUpload(data: Data) throws -> Data {
        do {
            let result = if ImageUploadFormat.detect(data: data) == .png {
                try JPEGTranscoder.transcodeToPNG(
                    imageData: data,
                    maxLongEdgePx: self.maxLongEdgePx,
                    maxBytes: self.maxPayloadBytes)
            } else {
                try JPEGTranscoder.transcodeToJPEG(
                    imageData: data,
                    maxLongEdgePx: self.maxLongEdgePx,
                    quality: self.jpegQuality,
                    maxBytes: self.maxPayloadBytes)
            }
            return result.data
        } catch JPEGTranscodeError.decodeFailed {
            throw ProcessError.notAnImage
        } catch JPEGTranscodeError.propertiesMissing {
            throw ProcessError.decodeFailed
        } catch JPEGTranscodeError.sizeLimitExceeded {
            throw ProcessError.encodeFailed
        } catch {
            throw ProcessError.encodeFailed
        }
    }
}
