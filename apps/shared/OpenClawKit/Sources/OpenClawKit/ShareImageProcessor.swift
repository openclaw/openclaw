import Foundation

/// Share Extension image policy built on the shared, orientation-normalizing JPEG transcoder.
public enum ShareImageProcessor {
    public static let maxLongEdgePx = 2560
    public static let jpegQuality = 0.9
    public static let maxPayloadBytes = 5_000_000

    public enum ProcessError: Error, LocalizedError, Sendable {
        case invalidImage
        case encodeFailed
        case sizeLimitExceeded

        public var errorDescription: String? {
            switch self {
            case .invalidImage:
                "The shared image could not be read."
            case .encodeFailed:
                "The shared image could not be converted to JPEG."
            case .sizeLimitExceeded:
                "The shared image could not be resized to fit the 5 MB attachment limit."
            }
        }
    }

    public static func processForUpload(data: Data) throws -> Data {
        do {
            return try JPEGTranscoder.transcodeToJPEG(
                imageData: data,
                maxLongEdgePx: self.maxLongEdgePx,
                quality: self.jpegQuality,
                maxBytes: self.maxPayloadBytes).data
        } catch JPEGTranscodeError.decodeFailed, JPEGTranscodeError.propertiesMissing {
            throw ProcessError.invalidImage
        } catch JPEGTranscodeError.sizeLimitExceeded {
            throw ProcessError.sizeLimitExceeded
        } catch {
            throw ProcessError.encodeFailed
        }
    }
}
