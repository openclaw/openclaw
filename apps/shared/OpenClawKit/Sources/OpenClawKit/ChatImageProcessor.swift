import Foundation

/// Prepares an image for upload in the chat attachment pipeline.
///
/// This is a thin chat-specific adapter over `JPEGTranscoder`, which already
/// handles EXIF-orientation normalization, progressive quality+pixel-size
/// search, and (post this PR) alpha flattening. The adapter exists so that
/// chat-specific policy — payload budget, max long-edge, error mapping —
/// lives in one place outside the view model.
///
/// Goals:
/// - Fit within a conservative payload budget (so WebSocket sends don't hang).
/// - Strip privacy-sensitive source metadata (EXIF DateTime/LensModel, GPS,
///   IPTC creator/copyright, TIFF make/model) from the output bytes by not
///   forwarding them to the destination. ImageIO will still emit a minimal
///   format-default APP1 EXIF block (orientation/version) — verified by
///   `test_outputContainsNoLeakedSensitiveStrings` against planted needles.
/// - Normalize to JPEG so the receiver has a predictable decode surface.
public enum ChatImageProcessor {
    /// Upper bound on the longest edge after resize, in pixels.
    public static let maxDimension: Int = 1600

    /// JPEG quality for the first re-encode pass. 0.8 is visually
    /// indistinguishable from the source for typical photos while cutting
    /// size ~5x.
    public static let jpegQuality: Double = 0.8

    /// Final safety budget. JPEGTranscoder's progressive search will degrade
    /// quality and pixel size to try to fit; if it can't, we throw — and
    /// `ChatViewModel` continues to enforce its 5 MB hard gate.
    public static let maxPayloadBytes = 3_500_000

    public enum ProcessError: Error, LocalizedError, Sendable {
        case notAnImage
        case decodeFailed
        case encodeFailed

        public var errorDescription: String? {
            switch self {
            case .notAnImage: "The data is not a recognizable image."
            case .decodeFailed: "The image could not be decoded."
            case .encodeFailed: "The image could not be re-encoded as JPEG."
            }
        }
    }

    /// Returns a processed JPEG `Data` safe to attach to a chat message, or
    /// throws `ProcessError` if the input isn't a recognizable image or cannot
    /// be encoded within the payload budget.
    public static func processForUpload(data: Data) throws -> Data {
        do {
            let result = try JPEGTranscoder.transcodeToJPEG(
                imageData: data,
                maxLongEdgePx: self.maxDimension,
                quality: self.jpegQuality,
                maxBytes: self.maxPayloadBytes)
            return result.data
        } catch let JPEGTranscodeError.decodeFailed {
            throw ProcessError.notAnImage
        } catch let JPEGTranscodeError.propertiesMissing {
            throw ProcessError.decodeFailed
        } catch JPEGTranscodeError.sizeLimitExceeded {
            throw ProcessError.encodeFailed
        } catch {
            throw ProcessError.encodeFailed
        }
    }
}
